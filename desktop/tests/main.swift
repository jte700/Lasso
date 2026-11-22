//  Native regression tests for insertion, dependency anchoring, and geometry.
//  Built and run by `npm run desktop:test` — no framework, no dependencies.

import Cocoa
import SwiftUI
import PDFKit
import CoreText

var failures = 0
var checks = 0

final class MemoryDirectoryDefaults: UserDefaults {
    var values: [String: Any] = [:]
    override func dictionary(forKey defaultName: String) -> [String: Any]? {
        values[defaultName] as? [String: Any]
    }
    override func string(forKey defaultName: String) -> String? {
        values[defaultName] as? String
    }
    override func object(forKey defaultName: String) -> Any? {
        values[defaultName]
    }
    override func stringArray(forKey defaultName: String) -> [String]? {
        values[defaultName] as? [String]
    }
    override func set(_ value: Any?, forKey defaultName: String) {
        values[defaultName] = value
    }
}

func check(_ condition: Bool, _ what: String) {
    checks += 1
    if condition {
        print("  ok   \(what)")
    } else {
        failures += 1
        print("  FAIL \(what)")
    }
}

func anchor(for phrase: String, in document: String) -> TextAnchor {
    let units = Array(document.utf16)
    let start = TextAnchorResolver.indices(of: Array(phrase.utf16), in: units).first!
    return TextAnchor.make(in: units, range: start..<(start + phrase.utf16.count))!
}

func resolvedRange(_ anchor: TextAnchor, _ document: String) -> Range<Int>? {
    if case .resolved(let range) = TextAnchorResolver.resolve(anchor, in: document) { return range }
    return nil
}

func text(_ document: String, _ range: Range<Int>) -> String {
    String(decoding: Array(document.utf16)[range], as: UTF16.self)
}


// ── Stage A: completion insertion ──────────────────────────────────────────
// Regression cover for the destructive bug: accepting a suggestion deleted the
// whole sentence, because the replacement length came from a server-supplied
// claim range with no relation to what was being inserted.

func units(_ value: String) -> [UInt16] { Array(value.utf16) }
func string(_ value: [UInt16]) -> String { String(decoding: value, as: UTF16.self) }

/// Runs the whole transaction against a simulated host and returns the result.
func accept(_ before: String, insert: String, caret: Int? = nil,
            replacement: CompletionReplacement? = nil)
    -> (after: String, range: Range<Int>?, failure: CompletionFailure?) {
    let document = units(before)
    let position = caret ?? document.count
    guard case .success(let plan) = CompletionTransaction.plan(
        document: document, caret: position, insertText: insert, replacement: replacement) else {
        return (before, nil, .rangeOutOfBounds)
    }
    if let failure = CompletionTransaction.validate(plan, against: document) {
        return (before, nil, failure)
    }
    let after = CompletionTransaction.apply(plan, to: document)
    switch CompletionTransaction.verify(before: document, after: after, plan: plan) {
    case .success(let range): return (string(after), range, nil)
    case .failure(let failure): return (string(after), nil, failure)
    }
}

print("sharing drag selection")
do {
    final class Surface {
        var visible = true
        var acceptedLinks = ["accepted-source"]
        var copiedText = "existing copied link"
    }
    let router = LassoTransientUI()
    let inspector = Surface(), share = Surface(), suggestions = Surface()
    var order: [String] = []
    for (owner, priority, name) in [(inspector, 80, "inspector"), (share, 100, "share"), (suggestions, 70, "suggestions")] {
        router.register(owner, priority: priority, isOpen: { [weak owner] in owner?.visible == true }, dismiss: { [weak owner] in
            owner?.visible = false
            order.append(name)
            check(!router.dismissAll(), "dismissal ignores nested Escape handling")
        })
    }
    check(router.dismissAll(), "Escape dismisses all registered open transient surfaces")
    check(order == ["share", "inspector", "suggestions"], "sharing detaches before its parent inspector or suggestion panel closes")
    check(!router.dismissAll(), "Escape after dismissal does not repeat UI actions")
    check([inspector, share, suggestions].allSatisfy { $0.acceptedLinks == ["accepted-source"] && $0.copiedText == "existing copied link" },
          "dismissal preserves accepted connections and copied content")
    var temporary: Surface? = Surface()
    router.register(temporary!, isOpen: { true }, dismiss: { fatalError("Released UI must not be dismissed") })
    temporary = nil
    check(!router.dismissAll(), "released UI owners do not receive dismissal callbacks")
}

do {
    func cell(_ row: Int, _ column: Int, sheet: Int = 0,
              effect: ShareRedactionEffect = .blur) -> ShareRedaction {
        ShareRedaction(kind: "CELL", sheet: sheet, row: row,
                       column: column, block: nil, effect: effect)
    }
    let anchor = cell(2, 1)
    let endpoint = cell(5, 3)
    let untouched = cell(9, 0, effect: .blank)
    let prior = [untouched.locationKey: untouched]
    let forward = ShareRedactionDrag(anchor: anchor, masks: prior)
    let selected = forward.masks(through: endpoint)
    check(selected.count == 13 && selected[cell(4, 2).locationKey] != nil,
          "a fast drag covers the whole inclusive rectangle between events")
    check(selected[untouched.locationKey] == untouched,
          "a drag preserves masks outside its selection")
    let reverse = ShareRedactionDrag(anchor: endpoint, masks: prior)
    check(reverse.masks(through: anchor) == selected,
          "reverse drags produce the same complete rectangle")
    let oppositeDiagonal = ShareRedactionDrag(anchor: cell(5, 1), masks: prior)
    check(oppositeDiagonal.masks(through: cell(2, 3)) == selected,
          "row and column directions can be reversed independently")
    check(forward.masks(through: anchor).count == 2,
          "shrinking a drag restores cells outside the current rectangle")
    let remove = ShareRedactionDrag(anchor: anchor, masks: selected)
    check(remove.masks(through: endpoint) == prior,
          "a drag beginning on a masked cell clears the whole selected range")
    let smallerRemoval = remove.masks(through: cell(3, 1))
    check(smallerRemoval.count == 11 && smallerRemoval[cell(4, 2).locationKey] != nil,
          "shrinking an erase drag restores the original masks")
    let click = ShareRedactionDrag(anchor: anchor, masks: [:]).masks(through: anchor)
    check(click == [anchor.locationKey: anchor]
          && ShareRedactionDrag(anchor: anchor, masks: click).masks(through: anchor).isEmpty,
          "single clicks still toggle one cell")
    let blocked = ShareRedactionDrag(anchor: cell(0, 0, effect: .blank), masks: [:])
        .masks(through: cell(0, 3))
    check(blocked.count == 4 && blocked.values.allSatisfy { $0.effect == .blank },
          "the selected redaction effect applies to every dragged cell")
    check(forward.masks(through: cell(5, 3, sheet: 1)) == prior,
          "a range never crosses worksheet boundaries")
    let firstBlock = ShareRedaction(kind: "BLOCK", sheet: nil, row: nil,
                                    column: nil, block: 4, effect: .blur)
    let lastBlock = ShareRedaction(kind: "BLOCK", sheet: nil, row: nil,
                                   column: nil, block: 1, effect: .blur)
    let blocks = ShareRedactionDrag(anchor: firstBlock, masks: [:]).masks(through: lastBlock)
    check(blocks.count == 4 && blocks["block:2"] != nil,
          "text drags include skipped sections in either direction")

    var history = ShareMaskHistory()
    history.record(from: [:], to: prior)
    history.record(from: prior, to: selected)
    history.record(from: selected, to: selected)
    check(history.undo(from: selected) == prior && history.undo(from: prior) == [:],
          "Command+Z takes back one whole drag at a time, and an edit that changed nothing is no step")
    check(history.undo(from: [:]) == nil, "with nothing left to take back, Command+Z changes nothing")
    check(history.redo(from: [:]) == prior && history.redo(from: prior) == selected && history.redo(from: selected) == nil,
          "Shift+Command+Z puts the masks back in order")
    _ = history.undo(from: selected)
    history.record(from: prior, to: [:])
    check(!history.canRedo && history.undo(from: [:]) == prior, "a new edit ends what could be redone")
    history.clear()
    check(!history.canUndo && !history.canRedo, "a new share starts with no history")

    check(ShareAccessScope.offered(for: .other, hasCitedPart: false) == [.document, .indexed, .redacted],
          "documents keep every share scope")
    check(ShareAccessScope.offered(for: .cadModel, hasCitedPart: true) == [.document, .indexed],
          "a CAD part citation shares the whole model or the cited part, with nothing to redact")
    check(ShareAccessScope.offered(for: .cadModel, hasCitedPart: false) == [.document],
          "a whole-model CAD citation is shared as the model")
    check(ShareAccessScope.offered(for: .presentation, hasCitedPart: true) == [.document, .indexed],
          "a slide's citation shares the whole deck or that slide, with nothing to redact")
    check(ShareAccessScope.offered(for: .presentation, hasCitedPart: false) == [.document],
          "a whole-deck citation is shared as the deck")
    check(ShareSourceKind(filename: "Review.PPTX") == .presentation && ShareSourceKind(filename: "Bracket.stp") == .cadModel
          && ShareSourceKind(filename: "Budget.xlsx") == .other, "a source's kind comes from its extension")
    check(["Plan.PDF", "Memo.docx", "Notes.txt", "Close.md", "Paper.tex", "Guide.rst"].allSatisfy { ShareSourceKind(filename: $0) == .writing },
          "PDFs, Word documents and text files are writing")
    check(ShareAccessScope.offered(for: .writing, hasCitedPart: true) == [.document, .redacted]
          && ShareAccessScope.offered(for: .writing, hasCitedPart: true, markable: true) == [.document, .redacted, .marked],
          "writing offers no cited part, even when a passage is cited")
    check(["Site Standup.mov", "Walkthrough.MP4", "Clip.m4v"].allSatisfy { ShareSourceKind(filename: $0) == .video }
          && ShareAccessScope.offered(for: .video, hasCitedPart: true) == [.document],
          "a video is shared whole, with nothing to cut out, redact or mark")
    check(["Site.png", "Photo.JPG", "Chart.gif", "Survey.tiff"].allSatisfy { ShareSourceKind(filename: $0) == .image }
          && ShareAccessScope.offered(for: .image, hasCitedPart: true) == [.document, .redacted],
          "a picture is shared whole or redacted, never as a cited part")
    check(["Plan.dxf", "Duplex.IFC"].allSatisfy { ShareSourceKind(filename: $0) == .planDrawing }
          && ShareAccessScope.offered(for: .planDrawing, hasCitedPart: true) == [.document, .redacted],
          "a 2D drawing is shared whole or redacted, never as a cited part")
    do {
        let picture = ShareDrawingLayout(frame: NSRect(x: 100, y: 50, width: 400, height: 200), kind: "IMAGE")
        let left = picture.redaction(from: NSPoint(x: 100, y: 50), to: NSPoint(x: 300, y: 150), effect: .blank)
        let right = picture.redaction(from: NSPoint(x: 300, y: 150), to: NSPoint(x: 500, y: 250), effect: .blur)
        check(left?.kind == "IMAGE" && left?.x == 0 && left?.y == 0 && left?.width == 0.5 && left?.height == 0.5,
              "an area dragged over a picture is its share of the picture from the top left")
        check(left.flatMap(picture.rect(for:)) == NSRect(x: 100, y: 50, width: 200, height: 100)
              && left?.locationKey != right?.locationKey,
              "each area of a picture is its own mask, drawn back where it was dragged")
        check(left.flatMap(ShareDrawingLayout(frame: picture.frame).rect(for:)) == nil,
              "a picture's mask is never read as a drawing's")
    }
    check(ShareAccessScope.offered(for: .other, hasCitedPart: false, markable: true) == [.document, .indexed, .redacted, .marked]
          && ShareAccessScope.offered(for: .presentation, hasCitedPart: false, markable: true) == [.document, .marked]
          && ShareAccessScope.offered(for: .presentation, hasCitedPart: true, markable: true) == [.document, .indexed, .marked],
          "PDFs, Word documents and decks can also be shared marked up")
    check(ShareSourceKind.isMarkable("Plan.PDF") && ShareSourceKind.isMarkable("Notes/Memo.docx") && ShareSourceKind.isMarkable("Deck.pptx")
          && !ShareSourceKind.isMarkable("Budget.xlsx") && !ShareSourceKind.isMarkable("Bracket.step"),
          "only documents shown as pages can be marked up")
}

print("Marking up a copy to share")
do {
    let crop = NSRect(x: 0, y: 0, width: 600, height: 800)
    var session = ShareMarkupSession()
    session.begin(page: 2, at: NSPoint(x: 60, y: 720), crop: crop, reach: 4)
    session.move(to: NSPoint(x: 60.4, y: 720), page: 2, crop: crop, reach: 4)
    session.move(to: NSPoint(x: 300, y: 720), page: 2, crop: crop, reach: 4)
    session.move(to: NSPoint(x: 300, y: 900), page: 2, crop: crop, reach: 4)
    check(session.marks.isEmpty && session.draft?.points.count == 3, "a stroke is drawn as a draft until the pointer lifts")
    session.end()
    let line = session.marks.first
    check(session.marks.count == 1 && line?.tool == .pen && line?.color == .red
          && line?.points == [CGPoint(x: 0.1, y: 0.1), CGPoint(x: 0.5, y: 0.1), CGPoint(x: 0.5, y: 0)],
          "a pen stroke keeps points from the page's top left, skips ones too close to see, and stays on its page")
    check(line?.payload["points"] as? [Double] == [0.1, 0.1, 0.5, 0.1, 0.5, 0] && line?.payload["tool"] as? String == "PEN"
          && line?.payload["color"] as? String == "#E5372B" && line?.payload["page"] as? Int == 2,
          "a stroke is sent as the server reads it")

    session.hand = .tool(.highlighter)
    check(session.color == .yellow, "the highlighter starts yellow")
    session.choose(.green)
    check(session.color(for: .highlighter) == .green && session.color(for: .pen) == .red, "each tool keeps its own colour")
    session.hand = .eraser
    check(session.color == nil, "the eraser has no colour")
    session.choose(.blue)
    check(session.hand == .tool(.pen) && session.color == .blue, "choosing a colour with the eraser in hand picks the pen back up")

    session.hand = .eraser
    session.begin(page: 1, at: NSPoint(x: 180, y: 722), crop: crop, reach: 4)
    session.end()
    check(session.marks.count == 1, "the eraser leaves marks on other pages")
    session.begin(page: 2, at: NSPoint(x: 590, y: 20), crop: crop, reach: 4)
    session.move(to: NSPoint(x: 180, y: 722), page: 2, crop: crop, reach: 4)
    session.end()
    check(session.marks.isEmpty, "dragging the eraser across a stroke takes it away")
    check(session.undo() && session.marks.count == 1 && session.redo() && session.marks.isEmpty && !session.redo(),
          "an erasing drag is one step for Command+Z and Shift+Command+Z")

    session.hand = .tool(.marker)
    session.begin(page: 1, at: NSPoint(x: 10, y: 10), crop: crop, reach: 4)
    session.cancel()
    check(session.marks.isEmpty && session.draft == nil, "a stroke under way is dropped when the composer changes what it shows")
    for _ in 0..<ShareMarkupSession.maxStrokes {
        session.begin(page: 1, at: NSPoint(x: 10, y: 10), crop: crop, reach: 4)
        session.end()
    }
    check(session.marks.count == ShareMarkupSession.maxStrokes && session.marks.last?.points.count == 1
          && !session.begin(page: 1, at: NSPoint(x: 20, y: 20), crop: crop, reach: 4),
          "a click draws a dot, and the copy stops taking strokes at the server's limit")

    var detailed = ShareMarkupSession()
    for stroke in 0..<(ShareMarkupSession.maxPoints / ShareMarkStroke.maxPoints) {
        detailed.begin(page: 1, at: .zero, crop: crop, reach: 4)
        for step in 1..<ShareMarkStroke.maxPoints {
            detailed.move(to: NSPoint(x: CGFloat(step * 2 % 600), y: CGFloat(step * 2 / 600 + stroke) * 4), page: 1, crop: crop, reach: 4)
        }
        detailed.end()
    }
    check(detailed.marks.reduce(0, { $0 + $1.points.count }) == ShareMarkupSession.maxPoints
          && !detailed.begin(page: 1, at: .zero, crop: crop, reach: 4),
          "the copy stops taking strokes once they hold as many points as the server takes")

    var full = ShareMarkStroke(tool: .pen, color: .black, page: 1, start: .zero, crop: crop)
    for step in 1...(ShareMarkStroke.maxPoints + 10) { full.extend(to: NSPoint(x: CGFloat(step * 2 % 600), y: CGFloat(step * 2 / 600) * 4), crop: crop) }
    check(full.points.count == ShareMarkStroke.maxPoints, "a stroke ends at the server's limit of points")
}

print("Command+Z takes back what Tab or a link inserted")
do {
    let element = AXUIElementCreateApplication(getpid())
    let typed = "The plate is bra"
    let after = units("The plate is Bracket.step")
    let insertion = AcceptedInsertion(element: element, caret: 100 + after.count,
                                      inserted: "Bracket.step", replaced: "bra")
    let plan = insertion.revertPlan(windowStart: 100, text: after, caret: 100 + after.count)
    check(plan.map { string(CompletionTransaction.apply($0, to: after)) } == typed,
          "undo puts back the typed word the insertion replaced")
    check(plan.map { CompletionTransaction.validate($0, against: after, caret: after.count) == nil } == true,
          "the undo edit is checked like any insertion")
    check(insertion.revertPlan(windowStart: 100, text: after + units("x"), caret: 101 + after.count) == nil,
          "after more typing the host's own undo applies")
    check(insertion.revertPlan(windowStart: 100, text: Array(after.dropLast(3)), caret: 97 + after.count) == nil,
          "a moved caret is not taken for the insertion's end")
    let edited = units("The plate is Bracket.stp ")
    check(insertion.revertPlan(windowStart: 100, text: edited, caret: 100 + edited.count) == nil,
          "inserted text that was changed is left alone")
    let unlink = insertion.unlinkPlan(windowStart: 100, text: after, caret: 100 + after.count)
    check(unlink.map { string(CompletionTransaction.apply($0, to: after)) } == "The plate is Bracket.step",
          "unlinking words chosen in the passage picker keeps them, written again as plain words")
    check(insertion.unlinkPlan(windowStart: 100, text: after + units("x"), caret: 101 + after.count) == nil,
          "after more typing unlinking leaves the field to the host")
    let nbsp = units("The hole is 8 mm\u{00A0}")
    let spaced = AcceptedInsertion(element: element, caret: nbsp.count, inserted: "8 mm ", replaced: "")
    check(spaced.revertPlan(windowStart: 0, text: nbsp, caret: nbsp.count)?.expectedPrefix == "8 mm\u{00A0}",
          "a trailing space the host shows as a no-break space is still the insertion")
}

print("sharing preserves clipboard changes")
do {
    let crop = NSRect(x: 30, y: 50, width: 400, height: 800)
    let selected = NSRect(x: 70, y: 650, width: 120, height: 80)
    let region = SharePDFRegion(page: 3, rect: selected, crop: crop)!
    check(abs(region.x - 0.1) < 1e-9 && abs(region.y - 0.15) < 1e-9,
          "PDF regions account for a crop box offset and top-left page coordinates")
    check(region.rect(in: crop) == selected, "PDF selection coordinates return to the same source area")
    let mask = region.redaction(effect: .blank)
    check(mask.payload["page"] as? Int == 3 && mask.kind == "PDF" && mask.locationKey.hasPrefix("pdf:3:"),
          "PDF masks keep the exact page through serialization and removal")
    check(SharePDFRegion(page: 0, rect: selected, crop: crop) == nil
          && SharePDFRegion(page: 1, rect: NSRect(x: 900, y: 900, width: 20, height: 20), crop: crop) == nil,
          "PDF selections reject missing pages and areas outside the page")
}
do {
    let model = AssistModelPreview(json: [
        "kind": "model-plan", "bounds": ["minX": 0, "minY": 0, "maxX": 100, "maxY": 100],
        "drawing": [["id": "A1", "type": "path", "points": [[0, 0], [100, 100]], "closed": false]],
    ])!
    let layout = ShareDrawingLayout(model: model, in: NSRect(x: 0, y: 0, width: 400, height: 300))!
    let a = NSPoint(x: layout.frame.minX + layout.frame.width * 0.2,
                    y: layout.frame.minY + layout.frame.height * 0.3)
    let b = NSPoint(x: layout.frame.minX + layout.frame.width * 0.7,
                    y: layout.frame.minY + layout.frame.height * 0.8)
    let mask = layout.redaction(from: a, to: b, effect: .blank)!
    check(mask.kind == "DRAWING" && abs(mask.x! - 0.2) < 1e-9 && abs(mask.y! - 0.3) < 1e-9
          && abs(mask.width! - 0.5) < 1e-9 && abs(mask.height! - 0.5) < 1e-9,
          "drawing drags map fitted source bounds to normalized top-left regions")
    check(layout.redaction(from: b, to: a, effect: .blank) == mask,
          "reverse drawing drags select the same source region")
    let restored = layout.rect(for: mask)!
    check(abs(restored.minX - a.x) < 1e-8 && abs(restored.maxY - b.y) < 1e-8,
          "region overlay uses the same fit and letterboxing as the drawing")
    check(layout.redaction(from: a, to: NSPoint(x: a.x + 1, y: a.y + 1), effect: .blur) == nil,
          "a click does not accidentally create a microscopic drawing mask")
    let entire = layout.redaction(from: NSPoint(x: -1000, y: -1000), to: NSPoint(x: 1000, y: 1000), effect: .blur)!
    check(entire.x == 0 && entire.y == 0 && entire.width == 1 && entire.height == 1,
          "drawing masks clamp to source bounds when a drag leaves the canvas")
    check(mask.payload["x"] as? Double == mask.x && mask.payload["kind"] as? String == "DRAWING"
          && mask.payload["effect"] as? String == "BLANK" && mask.payload["row"] == nil,
          "drawing masks serialize regions without worksheet coordinates")
    var invalid = mask
    invalid.width = .infinity
    check(layout.rect(for: invalid) == nil, "invalid drawing regions cannot become visible masks")
}

do {
    let pasteboard = NSPasteboard.withUniqueName()
    defer { pasteboard.releaseGlobally() }
    func copy(_ text: String) {
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }
    // A link is pasted on the Accessibility queue, and the clipboard is put
    // back there too. The main thread is not run while waiting.
    func borrow(_ text: String) {
        AccessibilityWork.queue.sync { RichTextInserter.withBorrowedPasteboard(pasteboard) { copy(text) } }
    }
    func finishPaste() {
        Thread.sleep(forTimeInterval: 0.7)
        AccessibilityWork.queue.sync {}
    }
    copy("Original clipboard")
    borrow("First link")
    finishPaste()
    check(pasteboard.string(forType: .string) == "Original clipboard",
          "sharing restores the original clipboard after the paste")
    borrow("Second link")
    copy("Newly copied text")
    finishPaste()
    check(pasteboard.string(forType: .string) == "Newly copied text",
          "a copy made during sharing is never overwritten")
    borrow("Third link")
    borrow("Fourth link")
    finishPaste()
    check(pasteboard.string(forType: .string) == "Newly copied text",
          "consecutive shares restore the user's original clipboard")
}

print("suggestion activation across permission changes")
do {
    var activation = AssistActivation(requested: false)
    activation.setRequested(true)
    check(activation.shouldAttempt(serverReady: true, accessibility: false,
                                   inputMonitoring: false, running: false,
                                   userInitiated: true),
          "first enable requests the missing permission")
    check(activation.requested, "missing permission keeps the user's enable choice")
    check(!activation.shouldAttempt(serverReady: true, accessibility: false,
                                    inputMonitoring: false, running: false),
          "waiting for Accessibility does not repeat permission requests")
    check(activation.shouldAttempt(serverReady: true, accessibility: true,
                                   inputMonitoring: false, running: false),
          "granting Accessibility resumes suggestions automatically")
    check(!activation.shouldAttempt(serverReady: true, accessibility: true,
                                    inputMonitoring: false, running: false),
          "failed tap creation does not retry on every timer tick")
    check(activation.shouldAttempt(serverReady: true, accessibility: true,
                                   inputMonitoring: true, running: false),
          "granting Input Monitoring retries the pending activation")
    check(!activation.shouldAttempt(serverReady: true, accessibility: true,
                                    inputMonitoring: true, running: true),
          "active suggestions do not create another keyboard tap")
    activation.setRequested(false)
    check(!activation.shouldAttempt(serverReady: true, accessibility: true,
                                    inputMonitoring: true, running: false),
          "turning suggestions off prevents later automatic activation")
    activation.setRequested(true)
    check(!activation.shouldAttempt(serverReady: false, accessibility: true,
                                    inputMonitoring: true, running: false),
          "pending activation waits for its server")
    check(activation.shouldAttempt(serverReady: true, accessibility: true,
                                   inputMonitoring: true, running: false),
          "server recovery resumes the requested activation")
    var restored = AssistActivation(requested: true)
    check(restored.shouldAttempt(serverReady: true, accessibility: true,
                                 inputMonitoring: true, running: false),
          "a remembered enable choice resumes after app restart")
    check(restored.shouldAttempt(serverReady: true, accessibility: true,
                                 inputMonitoring: true, running: false,
                                 userInitiated: true),
          "explicit retry works after an unsuccessful automatic attempt")
}

print("email hyperlink formats")
do {
    let url = URL(string: "https://example.test/d/source?a=1&b=2")!
    let formats = RichTextInserter.representations(label: "Supplies & <cost>", url: url)
    let html = String(data: formats[.html]!, encoding: .utf8)!
    check(html.contains("Supplies &amp; &lt;cost&gt;"), "escapes source labels in rich email")
    check(html.contains("href=\"https://example.test/d/source?a=1&amp;b=2\""), "preserves the hyperlink destination")
    check(String(data: formats[.string]!, encoding: .utf8) == "Supplies & <cost>",
          "a box that takes only plain text gets the suggestion alone, never the URL beside it")
    let rtf = try! NSAttributedString(data: formats[.rtf]!, options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil)
    check(rtf.string == "Supplies & <cost>", "native rich-text paste preserves the label")
    check(rtf.attribute(.link, at: 0, effectiveRange: nil) != nil, "native rich-text paste retains a clickable link")
    check(RichTextInserter.containsLink(rtf, to: url), "read-back rich text proves the expected share destination")
    check(!RichTextInserter.containsLink(NSAttributedString(string: rtf.string), to: url),
          "a matching label without a hyperlink cannot confirm a share")
    check(!RichTextInserter.containsLink(rtf, to: URL(string: "https://example.test/wrong")!),
          "a hyperlink to another destination cannot confirm a share")
}

print("a pasted share link is judged by what landed at the caret")
do {
    let url = URL(string: "http://127.0.0.1:4319/s/abc")!
    let before = CompletionSnapshot(documentStart: 40, text: units("The total is office sup"))
    let plan = CompletionPlan(range: 13..<23, expectedPrefix: "office sup", insertText: "Office supplies",
                              sourceRange: 0..<15)
    func after(_ text: String) -> CompletionSnapshot { CompletionSnapshot(documentStart: 40, text: units(text)) }
    func landing(_ text: String, linked: Bool = true) -> RichTextInserter.LinkLanding? {
        RichTextInserter.landing(of: plan, before: before, after: after(text)) { _ in linked }
    }

    var asked: [String] = []
    let linked = RichTextInserter.landing(of: plan, before: before, after: after("The total is Office supplies")) { label in
        asked.append(label)
        return true
    }
    check(linked == .linked && asked == ["Office supplies"],
          "the suggestion's own text, replacing what was typed, is the link")
    check(landing("The total is Office supplies", linked: false) == .plainText,
          "the suggestion's text without a link is plain text, as a plain-text box takes it")
    check(landing("The total is Office supplies (\(url.absoluteString))") == nil,
          "the URL pasted beside the suggestion never counts as an inserted link")
    asked = []
    check(RichTextInserter.landing(of: plan, before: before, after: after("The total is office sup")) { label in
        asked.append(label)
        return true
    } == nil && asked.isEmpty, "nothing landed yet, so no link is read for")
    check(landing("A total is Office supplies") == nil, "a paste that changed other text counts for nothing")

    // Copy link's clipboard, after a paste whose borrowed clipboard is still out.
    let pasteboard = NSPasteboard.withUniqueName()
    defer { pasteboard.releaseGlobally() }
    pasteboard.clearContents()
    pasteboard.setString("Original clipboard", forType: .string)
    AccessibilityWork.queue.sync {
        RichTextInserter.withBorrowedPasteboard(pasteboard) {
            pasteboard.clearContents()
            pasteboard.setString("Office supplies", forType: .string)
        }
        RichTextInserter.copyLink(url, to: pasteboard)
    }
    Thread.sleep(forTimeInterval: 0.7)
    AccessibilityWork.queue.sync {}
    check(pasteboard.string(forType: .string) == url.absoluteString,
          "a link copied because the box took plain text stays on the clipboard")
}

print("delayed insertion guards")
do {
    let before = CompletionSnapshot(documentStart: 100, text: units("hello sup"))
    check(CompletionTransaction.canRetry(before: before, current: before, selectionLength: 0,
          expectedPrefix: "sup", selectedPrefix: false), "unchanged caret permits keyboard fallback")
    check(!CompletionTransaction.canRetry(before: before,
          current: CompletionSnapshot(documentStart: 200, text: before.text), selectionLength: 0,
          expectedPrefix: "sup", selectedPrefix: false), "identical text at a moved caret is rejected")
    check(!CompletionTransaction.canRetry(before: before, current: before, selectionLength: 4,
          expectedPrefix: "sup", selectedPrefix: false), "a newly selected range cannot be overwritten")
    let selected = CompletionSnapshot(documentStart: 100, text: units("hello "))
    check(CompletionTransaction.canRetry(before: before, current: selected, selectionLength: 3,
          expectedPrefix: "sup", selectedPrefix: true), "exact prepared prefix selection permits retry")
    check(!CompletionTransaction.canRetry(before: before, current: selected, selectionLength: 2,
          expectedPrefix: "sup", selectedPrefix: true), "a changed prefix selection is rejected")
    check(HostTextSafety.isSecure(role: "AXTextField", subrole: "AXSecureTextField"),
          "secure text subroles are excluded before text reads")
    check(CompletionTransaction.resolvedSelectedText(direct: "", rangeText: "Inv", valueSlice: "Inv", expectedLength: 3) == "Inv"
          && CompletionTransaction.resolvedSelectedText(direct: nil, rangeText: "", valueSlice: "Inv", expectedLength: 3) == "Inv"
          && CompletionTransaction.resolvedSelectedText(direct: "xyz", rangeText: "Inv", valueSlice: "Inv", expectedLength: 3) == "xyz"
          && CompletionTransaction.resolvedSelectedText(direct: "", rangeText: nil, valueSlice: nil, expectedLength: 0) == "",
          "a lagging empty selected-text attribute falls back to the selected range while keeping genuine mismatches")
    check(CompletionTransaction.canReuseHostValue(beforeValue: "Inv", afterValue: "Inv", caret: 3, wroteText: false)
          && CompletionTransaction.canReuseHostValue(beforeValue: "Inv\u{00A0}", afterValue: "Inv ", caret: 4, wroteText: true),
          "unchanged or space-equivalent host values remain reusable for keyboard fallback")
    check(CompletionTransaction.canReuseHostValue(beforeValue: "Invoice", afterValue: "Inv", caret: 3, wroteText: false)
          && CompletionTransaction.canReuseHostValue(beforeValue: "Invoice\nBody", afterValue: "Inv\nBody", caret: 3, wroteText: false)
          && CompletionTransaction.canReuseHostValue(beforeValue: "Invoice", afterValue: "Inv", caret: 3, wroteText: false, markedRange: 3..<7),
          "dismissing an inline prediction after the caret without writing text still permits keyboard fallback")
    check(CompletionTransaction.canReuseHostValue(beforeValue: "Inv", afterValue: "Invoice", caret: 3, wroteText: false, afterMarkedRange: 3..<7)
          && !CompletionTransaction.canReuseHostValue(beforeValue: "Inv", afterValue: "Invoice", caret: 3, wroteText: false),
          "only an explicit marked prediction appearing after the caret permits keyboard fallback")
    check(!CompletionTransaction.canReuseHostValue(beforeValue: "Inv hello", afterValue: "Inv world", caret: 3, wroteText: false)
          && !CompletionTransaction.canReuseHostValue(beforeValue: "Inv hello", afterValue: "Inv hi", caret: 3, wroteText: false)
          && !CompletionTransaction.canReuseHostValue(beforeValue: "Inv", afterValue: "In", caret: 3, wroteText: false)
          && !CompletionTransaction.canReuseHostValue(beforeValue: "Inv", afterValue: "Invinvoice", caret: 3, wroteText: true),
          "unrelated edits or partial accessibility writes block keyboard fallback")
    check(CompletionTransaction.prefersKeyboardInsertion(bundleIdentifier: "com.apple.Notes")
          && !CompletionTransaction.prefersKeyboardInsertion(bundleIdentifier: "com.apple.TextEdit")
          && !CompletionTransaction.prefersKeyboardInsertion(bundleIdentifier: nil),
          "Apple Notes replaces directly by keyboard instead of mutating AXSelectedTextRange")
    check(CompletionTransaction.appliedWithUncollapsedSelection(
            beforeValue: "Lasso\nInv", afterValue: "Lasso\nInvoice",
            editRange: 6..<9, insertText: "Invoice", selection: 6..<9)
          && CompletionTransaction.appliedWithUncollapsedSelection(
            beforeValue: "Lasso\nInv", afterValue: "Lasso\nInvoice",
            editRange: 6..<9, insertText: "Invoice", selection: 6..<13),
          "an accessibility write that landed the exact text but left a selection inside it is recognised")
    check(!CompletionTransaction.appliedWithUncollapsedSelection(
            beforeValue: "Lasso\nInv", afterValue: "Lasso\nInv",
            editRange: 6..<9, insertText: "Inv", selection: 6..<9)
          && !CompletionTransaction.appliedWithUncollapsedSelection(
            beforeValue: "Lasso\nInv", afterValue: "Lasso\nInvoiceoice",
            editRange: 6..<9, insertText: "Invoice", selection: 6..<9)
          && !CompletionTransaction.appliedWithUncollapsedSelection(
            beforeValue: "Lasso\nInv", afterValue: "Lasso\nInvoice",
            editRange: 6..<9, insertText: "Invoice", selection: 13..<13)
          && !CompletionTransaction.appliedWithUncollapsedSelection(
            beforeValue: "Lasso\nInv", afterValue: "Lasso\nInvoice",
            editRange: 6..<9, insertText: "Invoice", selection: 0..<5),
          "unchanged text, corrupted suffixes, collapsed carets and outside selections are not mistaken for an uncollapsed write")
    let notesBefore = CompletionSnapshot(documentStart: 0, text: units("Lasso\nInv"))
    check(CompletionTransaction.checkPrefixDeletion(
            before: notesBefore, after: CompletionSnapshot(documentStart: 0, text: units("Lasso\n")),
            expectedPrefix: "Inv") == .complete
          && CompletionTransaction.checkPrefixDeletion(
            before: CompletionSnapshot(documentStart: 0, text: units("Inv")),
            after: CompletionSnapshot(documentStart: 0, text: units("")),
            expectedPrefix: "Inv") == .complete,
          "removing the full typed prefix passes the deletion check, including at offset 0")
    check(CompletionTransaction.checkPrefixDeletion(
            before: notesBefore, after: CompletionSnapshot(documentStart: 0, text: units("Lasso\nI")),
            expectedPrefix: "Inv") == .incomplete(remaining: "I")
          && CompletionTransaction.checkPrefixDeletion(
            before: notesBefore, after: notesBefore,
            expectedPrefix: "Inv") == .incomplete(remaining: "Inv"),
          "a partial prefix left after backspaces reports the exact remaining characters")
    check(CompletionTransaction.checkPrefixDeletion(
            before: notesBefore, after: CompletionSnapshot(documentStart: 0, text: units("Lasso")),
            expectedPrefix: "Inv") == .changed
          && CompletionTransaction.checkPrefixDeletion(
            before: notesBefore, after: CompletionSnapshot(documentStart: 0, text: units("Other\n")),
            expectedPrefix: "Inv") == .changed
          && CompletionTransaction.checkPrefixDeletion(
            before: notesBefore, after: CompletionSnapshot(documentStart: 0, text: units("Lasso\nInvx")),
            expectedPrefix: "Inv") == .changed,
          "over-deletion, unrelated edits and new typing stop prefix deletion")
}

print("selection past an inline prediction")
do {
    // "…the outsta|" with macOS showing "nding" in grey: the caret is at 62
    // and the typed word starts at 56.
    let word = 56..<62
    let caret = 62..<62
    check(CompletionTransaction.checkSelection(requested: word, reported: word, caret: 62, markedText: false)
          == .selected, "the typed word reported as selected may be written over")
    check(CompletionTransaction.checkSelection(requested: word, reported: caret, caret: 62, markedText: false)
          == .retry, "a selection swallowed by a dismissed prediction is asked for again")
    check(CompletionTransaction.checkSelection(requested: word, reported: 67..<67, caret: 62, markedText: false)
          == .stop, "a caret moved past an accepted prediction stops the write")
    check(CompletionTransaction.checkSelection(requested: word, reported: nil, caret: 62, markedText: false)
          == .stop, "an unreadable selection stops the write")
    check(CompletionTransaction.checkSelection(requested: caret, reported: caret, caret: 62, markedText: true)
          == .retry, "a plain insertion waits until the prediction is gone")
    check(CompletionTransaction.checkSelection(requested: caret, reported: caret, caret: 62, markedText: false)
          == .selected, "a plain insertion at a clear caret goes ahead")
    check(CompletionTransaction.checkSelection(requested: word, reported: word, caret: 62, markedText: true)
          == .retry, "a selected word with marked text still showing is asked for again")
    // A selection that never landed falls back to typing, which must refuse a
    // caret left anywhere else. The snapshot ends at the caret, so it shows.
    let before = CompletionSnapshot(documentStart: 0, text: units("the outsta"))
    check(!CompletionTransaction.canRetry(before: before,
          current: CompletionSnapshot(documentStart: 0, text: units("the outst")), selectionLength: 0,
          expectedPrefix: "outsta", selectedPrefix: false), "typing is refused at a caret moved one character back")
    check(!CompletionTransaction.canRetry(before: before,
          current: CompletionSnapshot(documentStart: 0, text: units("the ")), selectionLength: 0,
          expectedPrefix: "outsta", selectedPrefix: false), "typing is refused at a caret collapsed to the word start")
}

/// Behaves as Notes did when probed: a selection change while the grey
/// prediction shows only dismisses it, and the caret stays where it was.
final class PredictingHost: SelectableHostText {
    var selected: Range<Int>
    var prediction: Bool
    /// macOS shows the prediction again whenever the caret is back at the word end.
    var predictionReturns = false
    /// The host takes its prediction instead of dropping it, moving the caret past it.
    var acceptsPrediction = false
    private(set) var selectionWrites = 0
    private let wordEnd: Int

    init(caret: Int, prediction: Bool) {
        selected = caret..<caret
        wordEnd = caret
        self.prediction = prediction
    }

    func setSelection(_ range: Range<Int>) -> Bool {
        selectionWrites += 1
        if prediction {
            prediction = false
            if acceptsPrediction { selected = (wordEnd + 5)..<(wordEnd + 5) }
            return true
        }
        selected = range
        if predictionReturns, range == wordEnd..<wordEnd { prediction = true }
        return true
    }

    var selection: Range<Int>? { selected }
    var hasMarkedText: Bool { prediction }
}

print("selecting in a host showing a prediction")
do {
    let swallowing = PredictingHost(caret: 62, prediction: true)
    check(HostSelection.selectForWrite(56..<62, caret: 62, in: swallowing) && swallowing.selected == 56..<62
          && swallowing.selectionWrites == 2, "the typed word is selected on the second request")
    let bare = PredictingHost(caret: 62, prediction: true)
    check(HostSelection.selectForWrite(62..<62, caret: 62, in: bare) && bare.selected == 62..<62 && !bare.prediction,
          "a plain insertion clears the prediction and keeps the caret")
    let returning = PredictingHost(caret: 62, prediction: true)
    returning.predictionReturns = true
    check(!HostSelection.selectForWrite(62..<62, caret: 62, in: returning),
          "a prediction that keeps coming back stops the write")
    let accepting = PredictingHost(caret: 62, prediction: true)
    accepting.acceptsPrediction = true
    check(!HostSelection.selectForWrite(56..<62, caret: 62, in: accepting) && accepting.selectionWrites == 1,
          "a host that accepts its prediction stops the write")
    let plain = PredictingHost(caret: 62, prediction: false)
    check(HostSelection.selectForWrite(56..<62, caret: 62, in: plain) && plain.selectionWrites == 1,
          "without a prediction the word is selected once")
    let untouched = PredictingHost(caret: 62, prediction: false)
    check(HostSelection.selectForWrite(62..<62, caret: 62, in: untouched) && untouched.selectionWrites == 0,
          "without a prediction a plain insertion sets no selection")

    // Notes can swallow the first selection write without exposing marked text.
    final class SilentSwallowingHost: SelectableHostText {
        var selected: Range<Int>
        var swallowRemaining: Int
        private(set) var selectionWrites = 0
        init(caret: Int, swallowCount: Int) {
            selected = caret..<caret
            swallowRemaining = swallowCount
        }
        func setSelection(_ range: Range<Int>) -> Bool {
            selectionWrites += 1
            if swallowRemaining > 0 {
                swallowRemaining -= 1
                return true
            }
            selected = range
            return true
        }
        var selection: Range<Int>? { selected }
        var hasMarkedText: Bool { false }
    }
    let notesSwallow = SilentSwallowingHost(caret: 3, swallowCount: 1)
    check(HostSelection.selectForWrite(0..<3, caret: 3, in: notesSwallow) && notesSwallow.selected == 0..<3
          && notesSwallow.selectionWrites == 2,
          "a host that swallows a selection without exposing marked text is retried until the range lands")
    let stuckCollapsed = SilentSwallowingHost(caret: 3, swallowCount: 10)
    check(!HostSelection.selectForWrite(0..<3, caret: 3, in: stuckCollapsed) && stuckCollapsed.selected == 3..<3,
          "a host whose selection stays collapsed at the caret stops the Accessibility write instead of appending")

    // A host that accepts the selection range while keeping marked text clears
    // it only when selection actually changes off that range.
    final class StickyMarkedHost: SelectableHostText {
        var selected: Range<Int>
        var marked = true
        init(caret: Int) { selected = caret..<caret }
        func setSelection(_ range: Range<Int>) -> Bool {
            if range != selected && selected == 0..<3 { marked = false }
            selected = range
            return true
        }
        var selection: Range<Int>? { selected }
        var hasMarkedText: Bool { marked }
    }
    let stickyMarked = StickyMarkedHost(caret: 3)
    check(HostSelection.selectForWrite(0..<3, caret: 3, in: stickyMarked)
          && stickyMarked.selected == 0..<3 && !stickyMarked.marked,
          "retrying an already-selected range with lingering marked text steps off it first to clear the mark")
}

print("selection follows suggestion identity only within the same query")
do {
    func suggestion(_ object: String?, _ text: String, project: String = "finance") -> AssistSuggestionSelection.Identity {
        .init(projectId: project, objectId: object, insertText: text)
    }
    let revenue = suggestion("revenue", "Revenue")
    let returns = suggestion("returns", "Returns")
    let result = suggestion("result", "Result")
    let before = [revenue, returns, result]
    let reordered = [returns, result, revenue]
    check(AssistSuggestionSelection.index(keeping: before[2], in: reordered, sameQuery: false) == 0,
          "new typing resets a previously selected third row to the strongest result")
    check(AssistSuggestionSelection.index(keeping: before[2], in: reordered, sameQuery: true) == 1,
          "refreshing the same query follows the chosen source to its new rank")
    check(AssistSuggestionSelection.index(keeping: result, in: [returns, revenue], sameQuery: true) == 0,
          "a disappeared choice returns to the strongest result rather than the old row number")
    check(AssistSuggestionSelection.index(keeping: result,
          in: [returns, suggestion("other", "Result")], sameQuery: true) == 0,
          "equal wording from another source does not inherit the selection")
    check(AssistSuggestionSelection.index(keeping: result,
          in: [returns, suggestion("result", "Result", project: "other")], sameQuery: true) == 0,
          "a source from another directory does not inherit the selection")
    check(AssistSuggestionSelection.index(keeping: result,
          in: [returns, suggestion("result", "A different result")], sameQuery: true) == 0,
          "a different insertion from the same source does not inherit the selection")
    check(AssistSuggestionSelection.index(keeping: nil, in: reordered, sameQuery: true) == 0
          && AssistSuggestionSelection.index(keeping: result, in: [], sameQuery: true) == 0,
          "new and empty cards have a valid first selection")
}

print("canonical source identity")
do {
    let workbook = AssistSourceIdentity.canonicalPath(
        candidatePath: "Income-Statement-Template.xls",
        provenanceLabel: "Accounting · Supplies · Current Period")
    check(workbook == "Income-Statement-Template.xls",
          "uses the owning file instead of a row or column breadcrumb")
    check(AssistSourceIdentity.key(path: "Folder/../Income-Statement-Template.xls",
                                   objectId: "cell") ==
          AssistSourceIdentity.key(path: "Income-Statement-Template.xls",
                                   objectId: "row"),
          "groups different indexed objects from the same normalized file")
    check(AssistSourceIdentity.key(path: "Folder\\Income-Statement-Template.xls",
                                   objectId: "windows") ==
          AssistSourceIdentity.key(path: "Folder/Income-Statement-Template.xls",
                                   objectId: "posix"),
          "normalizes source separators across metadata producers")
    check(AssistSourceIdentity.key(path: "Paper.pdf", objectId: "a") !=
          AssistSourceIdentity.key(path: "Workbook.xlsx", objectId: "b"),
          "keeps different source documents distinct")
    let colors = AssistSourceIdentity.colorAssignments(
        [(key: "workbook", preferred: 0),
         (key: "workbook", preferred: 1),
         (key: "paper", preferred: 0)],
        paletteCount: 8,
        fallback: { _ in 0 })
    check(colors["workbook"] == 0 && colors["paper"] == 1,
          "repairs legacy same-source colors and avoids cross-source collisions")
}

print("local source files")
do {
    let root = "/tmp/Lasso Source Project"
    let rootURL = URL(fileURLWithPath: root, isDirectory: true)
        .standardizedFileURL.resolvingSymlinksInPath()
    let workbook = rootURL.appendingPathComponent("Accounting/Income Statement.xlsx").path
    let exists: (String) -> Bool = { $0 == workbook }

    let resolved = AssistSourceIdentity.localFileURL(
        projectRoot: root, sourcePath: "Accounting/Income Statement.xlsx", fileExists: exists)
    check(resolved?.path == workbook, "resolves a project-relative indexed file")
    let windows = AssistSourceIdentity.localFileURL(
        projectRoot: root, sourcePath: "Accounting\\Income Statement.xlsx", fileExists: exists)
    check(windows?.path == workbook, "normalizes source separators before opening")
    let absolute = AssistSourceIdentity.localFileURL(
        projectRoot: root, sourcePath: workbook, fileExists: exists)
    check(absolute?.path == workbook, "accepts an absolute source inside the project")
    check(AssistSourceIdentity.localFileURL(
        projectRoot: root, sourcePath: "../outside.xlsx", fileExists: { _ in true }) == nil,
          "rejects a relative path that escapes the project")
    check(AssistSourceIdentity.localFileURL(
        projectRoot: root, sourcePath: "/tmp/outside.xlsx", fileExists: { _ in true }) == nil,
          "rejects an absolute path outside the project")
    check(AssistSourceIdentity.localFileURL(
        projectRoot: root, sourcePath: "missing.xlsx", fileExists: { _ in false }) == nil,
          "does not ask macOS to open a missing file")
}

print("intentional source opening")
do {
    let root = "/tmp/Lasso Source Project"
    var opens = 0
    var recorded = 0
    let exists: (String) -> Bool = { $0.hasSuffix("/Source.csv") }
    let open: (URL) -> Bool = { _ in opens += 1; return true }
    let record: () -> Void = { recorded += 1 }
    let succeeded = AssistSourceIdentity.openLocalFile(
        projectRoot: root, sourcePath: "Source.csv", fileExists: exists,
        open: open, onOpened: record)
    check(succeeded == .opened && opens == 1 && recorded == 1,
          "records usage after a deliberate local source successfully opens")
    let failed = AssistSourceIdentity.openLocalFile(
        projectRoot: root, sourcePath: "Source.csv", fileExists: exists,
        open: { _ in opens += 1; return false }, onOpened: record)
    check(failed == .failed && opens == 2 && recorded == 1,
          "failed macOS source opens do not count as use")
    let missing = AssistSourceIdentity.openLocalFile(
        projectRoot: root, sourcePath: "Missing.csv", fileExists: exists,
        open: open, onOpened: record)
    let outside = AssistSourceIdentity.openLocalFile(
        projectRoot: root, sourcePath: "../Outside.csv", fileExists: { _ in true },
        open: open, onOpened: record)
    check(missing == .unavailable && outside == .unavailable && opens == 2 && recorded == 1,
          "missing and out-of-project sources are never opened or counted")
    _ = AssistSourceIdentity.localFileURL(projectRoot: root, sourcePath: "Source.csv", fileExists: exists)
    check(recorded == 1, "passive source resolution does not count as usage")
}

print("completion insertion preserves the sentence")
do {
    let one = accept("The expected cost of office sup", insert: "office supplies")
    check(one.after == "The expected cost of office supplies", "completes a partial phrase")
    check(one.range.map { string(Array(units(one.after)[$0])) } == "office supplies",
          "reports the exact inserted range")

    // Caret in the middle of a sentence: the tail must survive.
    let two = accept("I reviewed the quarterly office sup yesterday.",
                     insert: "office supplies", caret: 35)
    check(two.after == "I reviewed the quarterly office supplies yesterday.",
          "leaves the rest of the sentence untouched")

    let three = accept("The value is 61", insert: "612")
    check(three.after == "The value is 612", "extends a partial number")

    let four = accept("Revenue is $4.", insert: "$4.2M")
    check(four.after == "Revenue is $4.2M", "keeps the words before a value")
    check(four.after.hasPrefix("Revenue is "), "preserves the sentence opening")

    let five = accept("the cost is ", insert: "400")
    check(five.after == "the cost is 400", "inserts when nothing was typed towards it")
}

print("a completion replaces the word being typed towards it")
do {
    // Typing a word that appears later in the suggestion must replace that
    // word, not sit in front of it: "suppl" towards "office supplies" has to
    // give "office supplies", never "supploffice supplies".
    let midWord = accept("I was looking through the suppl", insert: "office supplies")
    check(midWord.after == "I was looking through the office supplies",
          "replaces a word the suggestion continues rather than appending to it")
    check(midWord.range.map { string(Array(units(midWord.after)[$0])) } == "office supplies",
          "the dependency covers the inserted phrase alone")

    let whole = accept("the cost of supplies", insert: "office supplies")
    check(whole.after == "the cost of office supplies", "replaces a fully typed word too")

    // The run that spells the start of the suggestion still wins, so finishing
    // a phrase rewrites the whole phrase rather than only its last word.
    let phrase = accept("The expected cost of office sup", insert: "office supplies")
    check(phrase.after == "The expected cost of office supplies",
          "a phrase already under way is still completed as a phrase")

    // And a word with nothing to do with the suggestion is left alone.
    let unrelated = accept("the quarterly figure is ", insert: "400")
    check(unrelated.after == "the quarterly figure is 400",
          "an insertion after a space replaces nothing")
    check(CompletionTransaction.replaceableLength(
        typedBeforeCaret: units("I reviewed the paperwork"), insertText: units("400")) == 0,
          "an unrelated word is not replaceable")

    // The bound that made the original bug impossible still holds.
    check(CompletionTransaction.replaceableLength(
        typedBeforeCaret: units("a very long identifier here"), insertText: units("sup")) <= 3,
          "never rewrites more characters than the suggestion contains")
    check(CompletionTransaction.replaceableLength(
        typedBeforeCaret: units("first second"), insertText: units("second third")) == 6,
          "reaches back no further than the word being typed")
}

print("a completion can never delete more than it inserts")

print("matched keywords replace only their captured fragment")
do {
    let opening = "I was looking at the "
    let requested = opening + "pro"
    let label = "AC20 FZK haus · Projekt-FZK-Haus"
    let keyword = CompletionReplacement.capture(start: opening.utf16.count,
        end: requested.utf16.count, in: requested, expectedText: "pro")!
    let replaced = accept(requested, insert: label, replacement: keyword)
    check(replaced.after == opening + label,
          "Tab replaces pro even when its source name starts with AC20")
    check(replaced.range == opening.utf16.count..<(opening.utf16.count + label.utf16.count),
          "source highlight covers the replacement rather than the old keyword")
    let middle = accept(requested + " yesterday.", insert: label, caret: requested.utf16.count,
                        replacement: keyword)
    check(middle.after == opening + label + " yesterday.",
          "keyword replacement preserves text before and after the caret")
    let emojiOpening = "Look at 🏡 the "
    let alias = emojiOpening + "architectural drawing"
    let fragment = CompletionReplacement.capture(start: emojiOpening.utf16.count,
        end: alias.utf16.count, in: alias)!
    check(accept(alias, insert: "Home", replacement: fragment).after == emojiOpening + "Home",
          "a verified alias can become a shorter label without damaging Unicode context")
    check(CompletionReplacement.capture(start: opening.utf16.count, end: requested.utf16.count,
        in: requested, expectedText: "other") == nil, "rejects a trigger that differs from the request text")
    check(CompletionReplacement.capture(start: -1, end: requested.utf16.count, in: requested) == nil,
          "rejects a trigger outside the captured request")
    check(CompletionReplacement.capture(start: 1, end: 2, in: "🏡") == nil,
          "rejects a range cutting through an emoji")
    if case .failure(let failure) = CompletionTransaction.plan(document: units(opening + "pri"),
        caret: requested.utf16.count, insertText: label, replacement: keyword) {
        check(failure == .prefixMismatch, "refuses replacement after the typed keyword changes")
    } else { check(false, "refuses replacement after the typed keyword changes") }
    let continuation = "We use pro"
    let append = CompletionReplacement(start: continuation.utf16.count, expectedText: "")
    check(accept(continuation, insert: "ordinary materials.", replacement: append).after ==
          continuation + "ordinary materials.",
          "sentence continuations append even when their first letters overlap the typed suffix")
}

print("acceptance spacing and retained source boundaries")
do {
    let typed = "the marketing rows for our"
    let append = CompletionReplacement(start: typed.utf16.count, expectedText: "")
    guard case .success(let spaced) = CompletionTransaction.plan(document: units(typed), caret: typed.utf16.count,
        insertText: "Department", replacement: append, separateInsertion: true) else { fatalError("spacing plan") }
    check(string(CompletionTransaction.apply(spaced, to: units(typed))) == typed + " Department",
          "an insertion after a complete connector separates the source name from existing words")
    check(spaced.sourceRange == 1..<11, "source range excludes the inserted word separator")
    let opening = "the marketing rows for our "
    let request = opening + "dep "
    let replacement = CompletionReplacement.capture(start: opening.utf16.count, end: request.utf16.count - 1,
        in: request, expectedText: "dep")!
    guard case .success(let retained) = CompletionTransaction.plan(document: units(request), caret: request.utf16.count,
        insertText: "department", replacement: replacement, separateInsertion: true) else { fatalError("retained spacing plan") }
    check(string(CompletionTransaction.apply(retained, to: units(request))) == opening + "department ",
          "recognized keyword replacement preserves the user's trailing space")
    check(retained.sourceRange == 0..<10, "source range excludes a retained trailing space")
    check(CompletionTransaction.insertionIsAtCaret("department ", in: opening + "department\u{00A0}"),
          "verifies the complete insertion including a browser-normalized trailing space")
    let normalized = units(opening + "department\u{00A0}")
    if case .success = CompletionTransaction.verify(before: CompletionSnapshot(documentStart: 0, text: units(request)),
        after: CompletionSnapshot(documentStart: 0, text: normalized), plan: retained) {
        check(true, "source verification accepts equivalent spaces within the insertion")
    } else { check(false, "source verification accepts equivalent spaces within the insertion") }
    check(CompletionReplacement.capture(start: 0, end: 3, in: "dep\n", expectedText: "dep") == nil,
          "replacement never reaches back across a new line")
    let named = "deploy.sh line 4 to line 15  "
    let spaces = named.utf16.count - 2
    check(CompletionReplacement.capture(start: spaces, end: named.utf16.count, in: named) == nil,
          "a fragment of spaces alone is not a word to replace")
    if let colon = CompletionReplacement.capture(start: spaces, end: named.utf16.count, in: named, replacingSpaces: true),
       case .success(let code) = CompletionTransaction.plan(document: units(named), caret: named.utf16.count,
            insertText: ":\nset -euo pipefail", replacement: colon, separateInsertion: true) {
        check(string(CompletionTransaction.apply(code, to: units(named))) == "deploy.sh line 4 to line 15:\nset -euo pipefail",
              "code's colon takes the place of spaces typed after the line numbers")
    } else { check(false, "code's colon takes the place of spaces typed after the line numbers") }
    let numeric = "  Our rate increased by 2"
    let number = CompletionReplacement.terminalNumber(in: numeric)!
    check(number.expectedText == "2" && number.start == numeric.utf16.count - 1,
          "numeric replacement preserves predicate words and leading whitespace")
    let result = accept(numeric, insert: "25%", replacement: number)
    check(result.after == "  Our rate increased by 25%", "numeric acceptance replaces only the numeric token")
    let manual = "Please send comments"
    guard case .success(let chosen) = CompletionTransaction.plan(document: units(manual), caret: manual.utf16.count,
        insertText: "supplies", replacement: CompletionReplacement(start: manual.utf16.count, expectedText: ""),
        separateInsertion: true) else { fatalError("manual insertion plan") }
    check(string(CompletionTransaction.apply(chosen, to: units(manual))) == manual + " supplies",
          "manually chosen sources do not consume an unrelated matching letter")
}

print("an accepted name is written in the sentence's case")
do {
    func cased(_ label: String, _ typed: String, after before: String) -> String {
        InsertionCasing.match(label, replacing: typed, after: before)
    }
    check(cased("Office Supplies", "office sup", after: "We spent on ") == "office supplies"
          && cased("Office Supplies", "office sup", after: "Done. ") == "Office Supplies"
          && cased("Office Supplies", "Office sup", after: "We spent on ") == "Office Supplies",
          "a title-case name is lowered mid-sentence after lower-case words, as before")
    check(cased("OPERATING EXPENSES", "operating expenses", after: "The other ") == "operating expenses"
          && cased("NET INCOME", "net inc", after: "Our ") == "net income"
          && cased("REVENUES", "revenues", after: "Total ") == "revenues",
          "a heading in capitals is written as words mid-sentence")
    check(cased("OPERATING EXPENSES", "operating expenses", after: "") == "Operating Expenses"
          && cased("OPERATING EXPENSES", "Operating expenses", after: "Costs rose. ") == "Operating Expenses"
          && cased("INTEREST (INCOME), EXPENSE & TAXES", "interest", after: "") == "Interest (Income), Expense & Taxes",
          "at the start of a sentence a heading in capitals is written in title case")
    check(cased("OPERATING EXPENSES", "OPERATING", after: "The other ") == "OPERATING EXPENSES",
          "capitals the writer typed themselves are kept")
    check(cased("NASA", "nasa", after: "Ask ") == "NASA" && cased("US GAAP", "us gaap", after: "Under ") == "US GAAP"
          && cased("EBITDA", "ebitda", after: "The ") == "EBITDA" && cased("Q3 REVENUE 2026", "q3 rev", after: "The ") == "Q3 revenue 2026",
          "acronyms keep their capitals; words with digits keep their form")
    check(cased("THE SYSTEM SHALL COMPLY", "", after: "It says ") == "THE SYSTEM SHALL COMPLY",
          "a value or passage added after the words is written as the source has it")
    check(cased("invoice", "Inv", after: "") == "Invoice"
          && cased("due date", "Due", after: "") == "Due date"
          && cased("o'clock", "O'c", after: "") == "O'clock",
          "a plain lower-case source word keeps the capital the writer typed on a title or sentence start")
    check(cased("iPhone", "Iph", after: "") == "iPhone"
          && cased("pH", "Ph", after: "") == "pH"
          && cased("invoice.pdf", "Inv", after: "") == "invoice.pdf"
          && cased("v2", "V2", after: "") == "v2"
          && cased("invoice", "inv", after: "The ") == "invoice",
          "mixed-case names, file names, tokens with digits and lower-case typing keep their original case")
}

print("saying \"tab\" while dictating accepts the card")
do {
    func snap(_ text: String, at start: Int = 0) -> CompletionSnapshot {
        CompletionSnapshot(documentStart: start, text: units(text))
    }
    func spoken(_ card: String, _ current: String) -> Int? {
        SpokenAccept.spokenLength(card: snap(card), current: snap(current))
    }
    let card = "I need the brac"
    check(spoken(card, card + " tab") == 4, "the word tab after the card's text is the command")
    check(spoken(card, card + " Tab.") == 5 && spoken(card, card + ". Tab.") == 6
          && spoken(card, card + " tab, ") == 6 && spoken(card, card + " TAB!") == 5,
          "dictation's capitals, punctuation and spacing around it are part of the command")
    check(spoken(card, card + " tab key") == 8 && spoken(card, card + "\t") == 1 && spoken(card, card + " \t") == 2,
          "tab key, which Dictation writes as a tab character, is the command too")
    check(spoken(card + " ", card + " tab") == 3, "after a space dictation already wrote, the word alone is the command")
    check(spoken(card, card + " tablet") == nil && spoken(card, card + " table") == nil
          && spoken(card, card + " stab") == nil && spoken(card, card + " tab tab") == nil
          && spoken(card, card + " new tab") == nil,
          "other words, or tab among them, are text")
    check(spoken(card, card + "tab") == nil, "tab written straight onto the last word is part of that word")
    check(spoken(card, card + "\ntab") == nil && spoken(card, card + " tab\n") == nil
          && spoken(card, card + "\t\t") == nil,
          "a line break or a second tab is text the writer asked for")
    check(spoken(card, card) == nil && spoken(card, String(card.dropLast())) == nil,
          "nothing new, or text taken away, is not the command")
    check(spoken(card, "I need thy brac tab") == nil && spoken("the bracket", "the brackets tab") == nil,
          "a word dictation revised near the end since the card showed makes the card out of date")
    let opening = "So looking at last quarter in some detail, we saw that "
    check(spoken(opening + card, "so looking at last quarter in some detail, we saw that " + card + " Tab.") == 5,
          "words dictation revised further back than the card's last words do not stop it")
    check(spoken(opening + card, "So looking at last quarter in some detail we saw that " + card + " Tab.") == nil,
          "a word revised among the card's last words does")
    check(spoken(card, "brac tab") == nil && spoken(card, "the brac tab") == nil,
          "a field holding only the last few of the card's words is not the card's")
    check(spoken(card, card + String(repeating: " ", count: 14) + "tab") == nil,
          "a long run of new text is not the command alone")
    let window = String(repeating: "x", count: 40) + " the brac"
    let slid = String(window.dropFirst(4)) + " tab"
    check(SpokenAccept.spokenLength(card: snap(window, at: 100), current: snap(slid, at: 104)) == 4
          && SpokenAccept.spokenLength(card: snap(window, at: -1), current: snap(slid, at: 100)) == 4,
          "the card lines up by its end, wherever the host says its text starts")
    check(SpokenAccept.nearMiss(units(card + " tap")) == "tap" && SpokenAccept.nearMiss(units(card + " Tabs.")) == "tabs"
          && SpokenAccept.nearMiss(units(card + " tab")) == nil && SpokenAccept.nearMiss(units(card + " laptop")) == nil,
          "a word recognition wrote for tab is named for the log, and nothing else is")
    check(SpokenAccept.change(from: "The other revenue was", to: "The other revenue. Was.") == "only punctuation or capitals"
          && SpokenAccept.change(from: "The other revenue", to: "The other revenue was") == "1 words added"
          && SpokenAccept.change(from: "The other revenue", to: "The outer revenue") == "earlier words changed"
          && SpokenAccept.change(from: card, to: card) == "nothing",
          "how the text changed since the card showed is described without the text")

    /// Plans Tab on the card's text, stretches it over the spoken word, and
    /// applies it to the field as it is now, checked as an insertion would be.
    func acceptSpoken(card: String, current: String, insert: String,
                      replacement: CompletionReplacement? = nil, separate: Bool = false,
                      cardStart: Int = 0, currentStart: Int = 0) -> (text: String, inserted: String)? {
        let cardSnap = snap(card, at: cardStart), currentSnap = snap(current, at: currentStart)
        guard let length = SpokenAccept.spokenLength(card: cardSnap, current: currentSnap),
              case .success(let planned) = CompletionTransaction.plan(document: units(card), caret: units(card).count,
                  insertText: insert, replacement: replacement, separateInsertion: separate),
              let plan = SpokenAccept.plan(planned, card: cardSnap, current: currentSnap, spokenLength: length),
              CompletionTransaction.validate(plan, against: units(current), caret: units(current).count) == nil
        else { return nil }
        let after = CompletionTransaction.apply(plan, to: units(current))
        guard case .success(let verified) = CompletionTransaction.verify(
            before: currentSnap, after: CompletionSnapshot(documentStart: currentStart, text: after), plan: plan)
        else { return nil }
        let source = plan.sourceRange ?? 0..<plan.insertText.utf16.count
        let inserted = Array(after[(verified.snapshotRange.lowerBound + source.lowerBound)
                                   ..< (verified.snapshotRange.lowerBound + source.upperBound)])
        return (string(after), string(inserted))
    }

    let keyword = CompletionReplacement.capture(start: 11, end: card.utf16.count, in: card, expectedText: "brac")!
    let replaced = acceptSpoken(card: card, current: card + " Tab.", insert: "Bracket", replacement: keyword)
    check(replaced?.text == "I need the Bracket" && replaced?.inserted == "Bracket",
          "one edit takes the word back out and replaces the typed fragment, as Tab would have")
    check(acceptSpoken(card: card, current: card + "\t", insert: "Bracket", replacement: keyword)?.text
          == "I need the Bracket", "tab key's tab character is taken back out too")
    let value = "The bracket is"
    let append = CompletionReplacement(start: value.utf16.count, expectedText: "")
    check(acceptSpoken(card: value, current: value + " tab", insert: "100 mm", replacement: append, separate: true)?.text
          == "The bracket is 100 mm", "a value or sentence continuation is spaced from the words before it")
    check(acceptSpoken(card: "office sup", current: "office sup tab", insert: "office supplies")?.text
          == "office supplies", "an inferred completion still rewrites only what was said towards it")
    let spaced = "for our dep "
    let kept = CompletionReplacement.capture(start: 8, end: 11, in: spaced, expectedText: "dep")!
    check(acceptSpoken(card: spaced, current: spaced + "tab", insert: "department", replacement: kept)?.text
          == "for our department ", "the space written before the word stays after the insertion")
    let longCard = String(repeating: "y", count: 40) + " the brac"
    let longKeyword = CompletionReplacement.capture(start: 45, end: longCard.utf16.count, in: longCard, expectedText: "brac")!
    check(acceptSpoken(card: longCard, current: String(longCard.dropFirst(4)) + " tab", insert: "Bracket",
                       replacement: longKeyword, cardStart: 100, currentStart: 104)?.text
          == String(repeating: "y", count: 36) + " the Bracket", "a moving window is written in its own offsets")
    if case .success(let planned) = CompletionTransaction.plan(document: units(card), caret: units(card).count,
                                                               insertText: "Bracket", replacement: keyword) {
        check(SpokenAccept.plan(planned, card: snap(card), current: snap("I need the brak tab"), spokenLength: 4) == nil,
              "the stretched edit refuses a field whose typed fragment changed")
        check(SpokenAccept.plan(planned, card: snap(card), current: snap(card + " tab"), spokenLength: 3) == nil,
              "the stretched edit must end exactly where the card's text did, plus the word")
    } else { check(false, "the stretched edit refuses a field whose typed fragment changed") }

    func pause(_ text: String) -> Int { SpokenAccept.pauseMarkLength(units(text)) }
    check(pause("Other revenue.") == 1 && pause("We spent on supplies, ") == 2 && pause("Is it net income?") == 1
          && pause("Revenue was 400.") == 1,
          "the mark dictation puts after a word at a pause is left out of the question")
    check(pause("Other revenue") == 0 && pause("Other revenue ") == 0 && pause("See (Revenue).") == 0
          && pause("Wait...") == 0 && pause("Total:\n") == 0 && pause(".") == 0,
          "anything but one mark straight after a word stays in the question")
    /// Tab on a card asked without the pause mark, written into the field that has it.
    func acceptAfterPause(_ field: String, insert: String, replacement: CompletionReplacement,
                          separate: Bool = false) -> String? {
        let length = pause(field)
        let answered = String(decoding: units(field).dropLast(length), as: UTF16.self)
        guard length > 0, case .success(let planned) = CompletionTransaction.plan(document: units(answered),
                caret: units(answered).count, insertText: insert, replacement: replacement, separateInsertion: separate),
              let plan = SpokenAccept.plan(planned, card: snap(answered), current: snap(field), spokenLength: length,
                                           keeping: String(decoding: units(field).suffix(length), as: UTF16.self)),
              CompletionTransaction.validate(plan, against: units(field), caret: units(field).count) == nil
        else { return nil }
        return string(CompletionTransaction.apply(plan, to: units(field)))
    }
    let other = "Other revenue"
    let otherName = CompletionReplacement.capture(start: 0, end: 13, in: other, expectedText: other)!
    check(acceptAfterPause(other + ".", insert: "Other Revenue", replacement: otherName) == "Other Revenue.",
          "Tab after a pause replaces the name and keeps dictation's mark after it")
    let was = "Other revenue was"
    check(acceptAfterPause(was + ". ", insert: "400", replacement: CompletionReplacement(start: 17, expectedText: ""),
                           separate: true) == "Other revenue was 400. ",
          "a value goes before the mark, not after it")
    if case .success(let planned) = CompletionTransaction.plan(document: units(other), caret: 13, insertText: "Other Revenue",
                                                               replacement: otherName),
       let plan = SpokenAccept.plan(planned, card: snap(other), current: snap(other + "."), spokenLength: 1, keeping: ".") {
        check(plan.sourceRange == 0..<13, "the link covers the name, not the mark kept after it")
    } else { check(false, "the link covers the name, not the mark kept after it") }
    check(acceptSpoken(card: other, current: other + ". Tab.", insert: "Other Revenue", replacement: otherName)?.text
          == "Other Revenue", "saying tab after a pause takes the mark out with the word, as the sentence goes on")

    check(DictationShortcut.isShortcut(176, flags: []) && DictationShortcut.isShortcut(176, flags: .maskSecondaryFn)
          && !DictationShortcut.isShortcut(176, flags: .maskCommand) && !DictationShortcut.isShortcut(96, flags: [])
          && !DictationShortcut.isShortcut(0, flags: []) && !DictationShortcut.isShortcut(48, flags: .maskSecondaryFn),
          "only the 🎤 key starts Dictation, alone or with fn; ⌘🎤, F5 typed as an F-key, letters and fn+Tab do not")

    let element = AXUIElementCreateApplication(getpid())
    let before = card + " tab"
    let after = units("I need the Bracket")
    let insertion = AcceptedInsertion(element: element, caret: after.count, inserted: "Bracket", replaced: "brac tab")
    check(insertion.revertPlan(windowStart: 0, text: after, caret: after.count)
              .map { string(CompletionTransaction.apply($0, to: after)) } == before,
          "⌘Z puts back the spoken word with the fragment, as the field was")
}

print("inferred completion replacement stays bounded by the insertion")
do {
    // The exact shape of the bug: a claim covering the whole sentence.
    let sentence = "The expected cost of office sup"
    let document = units(sentence)
    guard case .success(let plan) = CompletionTransaction.plan(
        document: document, caret: document.count, insertText: "Office Supplies") else {
        check(false, "plans an edit"); exit(1)
    }
    check(plan.range.count <= units("Office Supplies").count,
          "replacement is bounded by the inserted text")
    check(plan.range.count == 10, "rewrites only \"office sup\"")
    check(plan.expectedPrefix == "office sup", "knows exactly what it is replacing")

    let after = string(CompletionTransaction.apply(plan, to: document))
    check(after == "The expected cost of Office Supplies", "sentence survives")
    check(after.contains("The expected cost of"), "opening words are intact")
}

print("stale and invalid plans are refused")
do {
    let document = units("The expected cost of office sup")
    guard case .success(let plan) = CompletionTransaction.plan(
        document: document, caret: document.count, insertText: "office supplies") else {
        check(false, "plans an edit"); exit(1)
    }
    // The user kept typing after the suggestion was produced.
    let moved = units("The expected cost of office supper dish")
    check(CompletionTransaction.validate(plan, against: moved, caret: moved.count) == .prefixMismatch,
          "refuses a plan whose text has moved on")
    check(CompletionTransaction.validate(plan, against: units("The expected cost of office sup"),
                                         caret: 31) == nil,
          "accepts a plan that is still current")

    // A range beyond the document is refused rather than clamped.
    let short = units("short")
    check(CompletionTransaction.validate(plan, against: short) == .rangeOutOfBounds,
          "refuses a range outside the document")

    if case .failure(let failure) = CompletionTransaction.plan(
        document: document, caret: 999, insertText: "x") {
        check(failure == .rangeOutOfBounds, "refuses an impossible caret")
    } else {
        check(false, "refuses an impossible caret")
    }
}

print("verification catches a host that edits elsewhere")
do {
    let before = units("The expected cost of office sup")
    guard case .success(let plan) = CompletionTransaction.plan(
        document: before, caret: before.count, insertText: "office supplies") else {
        check(false, "plans an edit"); exit(1)
    }
    let correct = CompletionTransaction.apply(plan, to: before)
    check(CompletionTransaction.verify(before: before, after: correct, plan: plan) ==
            .success(21..<36), "accepts a clean edit")

    // The host also dropped an unrelated word.
    let damaged = units("expected cost of office supplies")
    if case .failure(let failure) = CompletionTransaction.verify(
        before: before, after: damaged, plan: plan) {
        check(failure == .outsideRangeModified, "rejects an edit that changed other text")
    } else {
        check(false, "rejects an edit that changed other text")
    }

    // The host did nothing at all.
    if case .failure(let failure) = CompletionTransaction.verify(
        before: before, after: before, plan: plan) {
        check(failure == .insertionMissing || failure == .outsideRangeModified,
              "rejects an edit that never happened")
    } else {
        check(false, "rejects an edit that never happened")
    }
}

print("moving browser windows verify an accepted dependency")
do {
    let lead = String(repeating: "x", count: 1_300)
    let fullBefore = units(lead + "The expected cost of office sup")
    let beforeStart = fullBefore.count - 1_200
    let beforeWindow = Array(fullBefore[beforeStart...])
    guard case .success(let plan) = CompletionTransaction.plan(
        document: beforeWindow, caret: beforeWindow.count, insertText: "office supplies") else {
        check(false, "plans inside a browser window"); exit(1)
    }
    let absoluteStart = beforeStart + plan.range.lowerBound
    var fullAfter = fullBefore
    fullAfter.replaceSubrange(
        (beforeStart + plan.range.lowerBound)..<(beforeStart + plan.range.upperBound),
        with: units(plan.insertText))
    let afterStart = fullAfter.count - 1_200
    let afterWindow = Array(fullAfter[afterStart...])
    let result = CompletionTransaction.verify(
        before: CompletionSnapshot(documentStart: beforeStart, text: beforeWindow),
        after: CompletionSnapshot(documentStart: afterStart, text: afterWindow), plan: plan)

    if case .success(let verified) = result {
        check(verified.documentRange == absoluteStart..<(absoluteStart + units(plan.insertText).count),
              "returns the absolute Gmail document range")
        check(string(Array(afterWindow[verified.snapshotRange])) == "office supplies",
              "returns the phrase inside the shifted window")
        let anchor = TextAnchor.make(in: afterWindow, range: verified.snapshotRange,
                                     documentOffset: afterStart)
        check(anchor?.approximateOffset == absoluteStart, "anchors with the absolute browser offset")
    } else {
        check(false, "verifies a completion after the 1,200-character window shifts")
    }
}

print("web editors normalize spaces without losing dependencies")
do {
    let beforeText = "The supplies increased by\u{00A0}"
    let before = units(beforeText)
    guard case .success(let plan) = CompletionTransaction.plan(
        document: before, caret: before.count, insertText: "400") else {
        check(false, "plans a value after a web-editor space"); exit(1)
    }
    let after = units("The supplies increased by 400")
    let normalized = CompletionTransaction.verify(
        before: CompletionSnapshot(documentStart: 0, text: before),
        after: CompletionSnapshot(documentStart: 0, text: after),
        plan: plan)
    if case .success(let verified) = normalized {
        check(verified.documentRange == before.count..<(before.count + 3),
              "accepts Gmail changing a trailing NBSP to a visible space")
        check(string(Array(after[verified.snapshotRange])) == "400",
              "anchors the second accepted dependency")
    } else {
        check(false, "accepts equivalent web-space normalization")
    }

    let damaged = units("The supplies increased on 400")
    let rejected = CompletionTransaction.verify(
        before: CompletionSnapshot(documentStart: 0, text: before),
        after: CompletionSnapshot(documentStart: 0, text: damaged),
        plan: plan)
    if case .failure(let failure) = rejected {
        check(failure == .outsideRangeModified, "still rejects an actual surrounding-text change")
    } else {
        check(false, "does not confuse changed words with normalized spaces")
    }

    check(!CompletionTransaction.insertionIsAtCaret("40", in: "An earlier value was 400"),
          "does not mistake an older overlapping value for a new insertion")
    check(CompletionTransaction.insertionIsAtCaret("40", in: "An earlier value was 400, now 40"),
          "recognizes the value only when it ends at the caret")
    let code = "\nif record is None:\n    return 404"
    check(CompletionTransaction.insertionIsAtCaret(code, in: "routes.py lines 9-10\rif record is None:\u{2029}    return 404"),
          "code lands in a host that reports its line breaks as carriage returns or paragraph separators")
    check(!CompletionTransaction.insertionIsAtCaret(code, in: "routes.py lines 9-10 if record is None:     return 404"),
          "a line break is still not a space")

    let alreadyTyped = accept("The prior-period value was 310", insert: "310")
    check(alreadyTyped.after == "The prior-period value was 310",
          "accepting a fully typed overlay value preserves its text")
    check(alreadyTyped.range.map { string(Array(units(alreadyTyped.after)[$0])) } == "310",
          "a fully typed overlay value still receives a dependency range")
}

print("the verified range is what the dependency anchors to")
do {
    let before = units("The expected cost of office sup")
    guard case .success(let plan) = CompletionTransaction.plan(
        document: before, caret: before.count, insertText: "office supplies"),
        case .success(let after) = Result<[UInt16], Never>.success(
            CompletionTransaction.apply(plan, to: before)),
        case .success(let range) = CompletionTransaction.verify(
            before: before, after: after, plan: plan) else {
        check(false, "produces a verified range"); exit(1)
    }
    // Stage B starts from that exact range, never from a fresh text search.
    let anchor = TextAnchor.make(in: after, range: range)!
    check(anchor.text == "office supplies", "anchors to exactly the accepted phrase")
    check(anchor.text != "The expected cost of office supplies", "does not swallow the sentence")
    check(anchor.text != "supplies", "does not anchor to a fragment")
    check(anchor.prefixContext.hasSuffix("cost of "), "records the text before it")
}

print("anchor creation")
do {
    let document = "The expected cost of office supplies is $400."
    let made = anchor(for: "office supplies", in: document)
    check(made.text == "office supplies", "captures the phrase")
    check(made.prefixContext.hasSuffix("expected cost of "), "captures preceding context")
    check(made.suffixContext.hasPrefix(" is $400"), "captures following context")
    check(made.approximateOffset == 21, "records where it started")
}

print("relocation after editing")
do {
    let original = "The expected cost of office supplies is $400."
    let made = anchor(for: "office supplies", in: original)

    let inserted = "In Q3, the expected cost of office supplies is $400."
    check(resolvedRange(made, inserted).map { text(inserted, $0) } == "office supplies",
          "survives text inserted before it")

    let deleted = "Cost of office supplies is $400."
    check(resolvedRange(made, deleted).map { text(deleted, $0) } == "office supplies",
          "survives text deleted before it")

    let after = "The expected cost of office supplies is $438 this quarter."
    check(resolvedRange(made, after).map { text(after, $0) } == "office supplies",
          "survives text changed after it")

    check(resolvedRange(made, "Nothing relevant here.") == nil, "does not invent a location")
    if case .unresolved(let reason) = TextAnchorResolver.resolve(made, in: "Nothing relevant here.") {
        check(reason == .textMissing, "reports the phrase as missing")
    }
}

print("duplicate phrases")
do {
    let document = "Office supplies were higher. We should review office supplies tomorrow."
    let units = Array(document.utf16)
    let second = TextAnchorResolver.indices(of: Array("office supplies".utf16), in: units)[0]
    let made = TextAnchor.make(in: units, range: second..<(second + 15))!

    let resolved = resolvedRange(made, document)
    check(resolved?.lowerBound == second, "picks the occurrence that was linked, not the first match")

    // Both occurrences keep their context: the linked one is still identifiable.
    let edited = "Office supplies were higher this year. We should review office supplies tomorrow."
    let editedUnits = Array(edited.utf16)
    let expected = TextAnchorResolver.indices(of: Array("office supplies".utf16), in: editedUnits)[0]
    check(resolvedRange(made, edited)?.lowerBound == expected,
          "stays on the linked occurrence after editing elsewhere")
}

print("ambiguity is refused")
do {
    // A repeating passage: several occurrences have identical context on both
    // sides, so nothing distinguishes them but position.
    let block = "the cost of office supplies is fine. "
    let document = String(repeating: block, count: 5)
    let units = Array(document.utf16)
    let middle = TextAnchorResolver.indices(of: Array("office supplies".utf16), in: units)[2]
    let made = TextAnchor.make(in: units, range: middle..<(middle + 15))!

    check(resolvedRange(made, document)?.lowerBound == middle,
          "position still identifies the linked occurrence")

    // Now place the remembered offset far from every candidate: position can no
    // longer decide, and the reference must refuse rather than guess.
    let adrift = TextAnchor(text: made.text, prefixContext: made.prefixContext,
                            suffixContext: made.suffixContext, approximateOffset: 10_000)
    if case .unresolved(let reason) = TextAnchorResolver.resolve(adrift, in: document) {
        check(reason == .ambiguous, "refuses to guess between identical candidates")
    } else {
        check(false, "refuses to guess between identical candidates")
    }
}

print("geometry")
do {
    // Accessibility reports top-left origin on the primary display; AppKit uses
    // bottom-left. Conversion must not depend on which screen the rect is on.
    let primaryHeight: CGFloat = 900
    let axRect = CGRect(x: 100, y: 200, width: 120, height: 18)
    let converted = HostGeometryConverter.toAppKit(axRect, primaryHeight: primaryHeight)
    check(converted.minX == 100, "x is unchanged")
    check(converted.maxY == primaryHeight - axRect.minY, "top edge maps to AppKit maxY")
    check(converted.height == axRect.height, "height is preserved")

    let roundTrip = HostGeometryConverter.toAccessibility(converted, primaryHeight: primaryHeight)
    check(abs(roundTrip.minY - axRect.minY) < 0.001, "conversion round-trips")

    let panel = CGRect(x: 90, y: 300, width: 160, height: 40)
    let screen = CGRect(x: 100, y: 312, width: 120, height: 18)
    let local = HostGeometryConverter.toPanelLocal(screen, panelFrame: panel)
    check(local.origin == CGPoint(x: 10, y: 12),
          "moves screen geometry into the overlay panel")
    check(local.size == screen.size,
          "keeps dependency highlight dimensions in panel space")
}

print("the suggestion card stays off the line being typed")
do {
    let visible = CGRect(x: 0, y: 0, width: 1440, height: 875)
    let card = CGSize(width: 520, height: 300)
    let caret = CGRect(x: 600, y: 400, width: 1, height: 18)

    let middle = CaretCardPlacement.beside(caret: caret, size: card, visible: visible)
    check(middle.frame.minY >= caret.maxY && !middle.pointerAtTop,
          "sits above the caret, leaving the typed line and the lines after it uncovered")
    check(middle.frame.minY - caret.maxY <= 4, "hangs just above the caret")
    check(middle.frame.minX + middle.pointerX == caret.midX, "points at the caret")

    let nearTop = CaretCardPlacement.beside(
        caret: CGRect(x: 600, y: 700, width: 1, height: 18), size: card, visible: visible)
    check(nearTop.frame.maxY <= 700 && nearTop.pointerAtTop,
          "drops below the caret only when the display has no room above")

    let tall = CGSize(width: 520, height: 700)
    let lowCaret = CGRect(x: 600, y: 200, width: 1, height: 18)
    let cramped = CaretCardPlacement.beside(caret: lowCaret, size: tall, visible: visible)
    check(!cramped.pointerAtTop && visible.contains(cramped.frame),
          "a card too tall for either side takes the roomier one and stays on screen")
    let highCaret = CGRect(x: 600, y: 600, width: 1, height: 18)
    let crampedHigh = CaretCardPlacement.beside(caret: highCaret, size: tall, visible: visible)
    check(crampedHigh.pointerAtTop && visible.contains(crampedHigh.frame),
          "the roomier side can be below when the caret sits high")

    let rightCaret = CGRect(x: 1300, y: 400, width: 1, height: 18)
    let right = CaretCardPlacement.beside(caret: rightCaret, size: card, visible: visible)
    check(right.frame.maxX == visible.maxX && right.frame.minX + right.pointerX == rightCaret.midX,
          "stays on screen at the right edge, its pointer sliding over to the caret")
    let left = CaretCardPlacement.beside(
        caret: CGRect(x: 20, y: 400, width: 1, height: 18), size: card, visible: visible)
    check(left.frame.minX == visible.minX && left.pointerX == CaretCardPlacement.pointerInset,
          "stays on screen at the left edge, its pointer kept clear of the rounded corner")

    let unknownScreen = CaretCardPlacement.beside(caret: caret, size: card, visible: nil)
    check(unknownScreen.frame.minY >= caret.maxY, "prefers above even without a display to fit")
}

print("the caret is measured on the line it is drawn on")
do {
    // Measured in Notes: after "The ou" in a 20pt title, the collapsed range
    // came back a line above the title, the characters on the title itself.
    let notesTitle = CGRect(x: 507.79, y: 99, width: 0, height: 23)
    let titleU = CGRect(x: 495.94, y: 122, width: 11.85, height: 23)
    check(CaretLine.aligned(notesTitle, before: titleU, after: nil)
            == CGRect(x: 507.79, y: 122, width: 0, height: 23),
          "takes a title's line from the character before the caret")
    let notesBody = CGRect(x: 483.41, y: 106, width: 0, height: 16)
    let bodyCharacter = CGRect(x: 479.83, y: 122, width: 3.58, height: 16)
    check(CaretLine.aligned(notesBody, before: bodyCharacter, after: nil).minY == 122,
          "takes body text's line from the character before the caret")

    let lineStart = CGRect(x: 444, y: 106, width: 0, height: 16)
    let firstCharacter = CGRect(x: 444, y: 122, width: 7.86, height: 16)
    check(CaretLine.aligned(lineStart, before: nil, after: firstCharacter).minY == 122,
          "at the start of a line, takes it from the character after the caret")

    let card = CGSize(width: 760, height: 396)
    let visible = CGRect(x: 0, y: 0, width: 1920, height: 1042)
    let primaryHeight: CGFloat = 1080
    let corrected = CaretLine.aligned(notesTitle, before: titleU, after: nil)
    let below = CaretCardPlacement.beside(
        caret: HostGeometryConverter.toAppKit(corrected, primaryHeight: primaryHeight),
        size: card, visible: visible)
    check(below.pointerAtTop && below.frame.maxY <= primaryHeight - titleU.maxY,
          "a card hanging below a Notes title leaves the title uncovered")

    var lookedAfter = false
    func measuredAfter() -> CGRect? { lookedAfter = true; return nil }
    let agreeing = CGRect(x: 100, y: 200, width: 0, height: 18)
    check(CaretLine.aligned(agreeing, before: CGRect(x: 92, y: 200, width: 8, height: 18),
                            after: measuredAfter()) == agreeing,
          "keeps a caret that agrees with the character before it")
    check(!lookedAfter, "measures the character after the caret only when needed")

    let wrapped = CGRect(x: 20, y: 218, width: 0, height: 18)
    let endOfLineAbove = CGRect(x: 300, y: 200, width: 8, height: 18)
    let startOfLine = CGRect(x: 20, y: 218, width: 8, height: 18)
    check(CaretLine.aligned(wrapped, before: endOfLineAbove, after: startOfLine) == wrapped,
          "a caret wrapped to a new line is not pulled back to the line above")
    check(CaretLine.aligned(agreeing, before: CGRect(x: 40, y: 240, width: 8, height: 18), after: nil)
            == agreeing,
          "ignores a character that does not touch the caret")
    check(CaretLine.aligned(agreeing, before: nil, after: nil) == agreeing,
          "keeps the caret when nothing beside it was measured")
}


print("browser editor text-run offsets")
do {
    let phrase = "I was looking at the supplies"
    for suffix in ["", "\n", "\n\n", "\r\n\r\n"] {
        check(WebTextReader.elementRanges(for: [phrase], in: phrase + suffix) == [0..<phrase.utf16.count],
              "trailing empty paragraphs do not change the word's offsets")
    }
    check(WebTextReader.elementRanges(for: ["First", "supplies", "Next"], in: "First\n\nsupplies\nNext")
          == [0..<5, 7..<15, 16..<20], "maps browser-generated paragraph separators")
    check(WebTextReader.elementRanges(for: ["office\nsupplies"], in: "office\nsupplies")
          == [0..<15], "preserves a literal newline inside a text leaf")
    check(WebTextReader.elementRanges(for: ["📦 ", "sup", "plies"], in: "📦 supplies")
          == [0..<3, 3..<6, 6..<11], "preserves UTF-16 offsets across emoji and rich text runs")
    check(WebTextReader.elementRanges(for: ["supplies", "supplies"], in: "supplies\nsupplies")
          == [0..<8, 9..<17], "keeps repeated words in their original document order")
    check(WebTextReader.elementRanges(for: ["supplies"], in: "unrelated supplies") == nil,
          "does not search ahead to an unrelated occurrence")
    check(WebTextReader.elementRanges(for: ["supplies"], in: "supplies changed") == nil,
          "rejects a stale or incomplete accessibility subtree")
    check(WebTextReader.elementRanges(for: ["First", "supplies"], in: "First other supplies") == nil,
          "does not skip missing visible text between runs")
}

print("highlights remain attached across newlines and caret movement")
do {
    let font = NSFont.systemFont(ofSize: 14)
    let base = "forecast for facilities was 48000."
    let prefix = "forecast for facilities was "
    let start = prefix.utf16.count
    let target = start..<(start + 5)
    let frame = CGRect(x: 100, y: 300, width: 500, height: 300)
    let adapter = AccessibilityTextAdapter()
    func width(_ value: String) -> CGFloat {
        NSAttributedString(string: value, attributes: [.font: font]).size().width
    }
    func measure(_ value: String, range: Range<Int>, caret: Int, x: CGFloat, y: CGFloat,
                 style: NSParagraphStyle? = nil) -> [CGRect] {
        var attributes: [NSAttributedString.Key: Any] = [.font: font]
        if let style { attributes[.paragraphStyle] = style }
        return adapter.layoutRects(
            attributedText: NSAttributedString(string: value, attributes: attributes),
            range: range, elementFrame: frame, caret: caret,
            actualCaret: CGRect(x: frame.minX + 5 + x, y: frame.minY + 2 + y, width: 1, height: 17))
    }
    func same(_ left: [CGRect], _ right: [CGRect]) -> Bool {
        left.count == right.count && zip(left, right).allSatisfy {
            abs($0.minX - $1.minX) < 0.1 && abs($0.minY - $1.minY) < 0.1
                && abs($0.width - $1.width) < 0.1 && abs($0.height - $1.height) < 0.1
        }
    }
    let original = measure(base, range: target, caret: base.utf16.count, x: width(base), y: 0)
    check(original.count == 1, "measures the accepted 48000 value on its text line")
    for (ending, lines, name) in [("\n", 1, "LF"), ("\n\n", 2, "blank paragraph"),
                                 ("\r\n", 1, "CRLF"), ("\u{2028}", 1, "line separator"),
                                 ("\u{2029}", 1, "paragraph separator")] {
        let value = base + ending
        let measured = measure(value, range: target, caret: value.utf16.count,
                               x: 0, y: CGFloat(lines) * 17)
        check(!measured.isEmpty && same(original, measured),
              "adding \(name) does not move the earlier highlight")
    }
    let ending = "All the best."
    let paragraphs = base + "\n\n" + ending
    for (caret, x, y) in [(0, CGFloat(0), CGFloat(0)),
                          (base.utf16.count + 1, 0, 17),
                          (base.utf16.count + 2, 0, 34),
                          (paragraphs.utf16.count, width(ending), 34)] {
        let measured = measure(paragraphs, range: target, caret: caret, x: x, y: y)
        check(!measured.isEmpty && same(original, measured),
              "moving the caret to offset \(caret) preserves the earlier highlight")
    }
    let blankLines = base + "\n\n"
    let all = measure(blankLines, range: 0..<blankLines.utf16.count,
                      caret: blankLines.utf16.count, x: 0, y: 34)
    check(all.count == 1 && (all.first?.width ?? frame.width) < frame.width * 0.75,
          "a range containing newlines draws text without container-wide blue strips")
    check(measure(blankLines, range: base.utf16.count..<blankLines.utf16.count,
                  caret: blankLines.utf16.count, x: 0, y: 34).isEmpty,
          "blank paragraphs alone have no highlight geometry")

    let style = NSMutableParagraphStyle()
    style.firstLineHeadIndent = 24
    style.paragraphSpacingBefore = 4
    style.lineSpacing = 3
    let styledOriginal = measure(base, range: target, caret: base.utf16.count,
                                  x: 24 + width(base), y: 0, style: style)
    let styledNewline = measure(base + "\n", range: target, caret: base.utf16.count + 1,
                                 x: 24, y: 24, style: style)
    check(!styledNewline.isEmpty && same(styledOriginal, styledNewline),
          "new paragraph caret retains indentation and paragraph spacing")
}

print("browser geometry respects line breaks and font metadata")
do {
    let units = Array("\na\r\nb\u{2028}c\u{2029}".utf16)
    check(WebTextReader.visibleGeometryRanges(forRange: 0..<units.count, inUTF16: units)
          == [1..<2, 4..<5, 6..<7], "browser ranges exclude every hard line break without shifting offsets")
    let emoji = Array("48000\n🙂".utf16)
    check(WebTextReader.visibleGeometryRanges(forRange: 0..<emoji.count, inUTF16: emoji)
          == [0..<5, 6..<8], "browser range splitting preserves UTF-16 offsets for emoji")
    check(WebTextReader.visibleGeometryRanges(forRange: -1..<2, inUTF16: units).isEmpty,
          "invalid negative browser offsets are refused")
    check(WebTextReader.visibleGeometryRanges(forRange: 0..<(units.count + 1), inUTF16: units).isEmpty,
          "browser offsets outside the text snapshot are refused")

    let value = "Forecast 48000"
    let font = NSFont.systemFont(ofSize: 32)
    let attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key("AXFont"): ["AXFontSize": 32],
    ]
    let expected = NSAttributedString(string: value, attributes: [.font: font])
    let rects = AccessibilityTextAdapter().layoutRects(
        attributedText: NSAttributedString(string: value, attributes: attributes),
        range: 9..<value.utf16.count, elementFrame: CGRect(x: 100, y: 300, width: 900, height: 100),
        caret: value.utf16.count, actualCaret: CGRect(x: 105 + expected.size().width, y: 302, width: 1, height: 39))
    let expectedWidth = NSAttributedString(string: "48000", attributes: [.font: font]).size().width
    check(rects.count == 1 && abs((rects.first?.width ?? 0) - expectedWidth) < 1.5,
          "Chromium AXFont size is used instead of a guessed capped font")
}

print("multi-line fragments")
do {
    // A wrapped phrase is several rectangles that must group into one hit target.
    let fragments = [
        CGRect(x: 10, y: 100, width: 200, height: 18),
        CGRect(x: 10, y: 122, width: 90, height: 18),
    ]
    let hit = DependencyGeometry(referenceId: "ref_1", fragments: fragments)
    check(hit.fragments.count == 2, "keeps one rectangle per line")
    check(hit.contains(CGPoint(x: 50, y: 108)), "hits the first line")
    check(hit.contains(CGPoint(x: 50, y: 130)), "hits the second line")
    check(!hit.contains(CGPoint(x: 400, y: 108)), "misses outside every fragment")
    check(hit.bounds.height >= 40, "bounds span both lines")

    let first = CGRect(x: 10, y: 100, width: 8, height: 18)
    let last = CGRect(x: 130, y: 100, width: 8, height: 18)
    check(HostGeometryConverter.isSingleLine(
        whole: first.union(last), first: first, last: last),
          "single-line geometry can skip per-character Accessibility reads")
    check(!HostGeometryConverter.isSingleLine(
        whole: hit.bounds, first: first,
        last: CGRect(x: 80, y: 122, width: 8, height: 18)),
          "wrapped endpoints still require line fragments")
    check(!HostGeometryConverter.isSingleLine(
        whole: CGRect(x: 10, y: 100, width: 128, height: 60), first: first, last: last),
          "matching endpoints do not hide multiline or column-spanning bounds")
    check(!HostGeometryConverter.isSingleLine(whole: .zero, first: first, last: last),
          "invalid host geometry never takes the single-line shortcut")

    let paragraph = NSAttributedString(
        string: "Office supplies and travel costs are shared across the entire department.",
        attributes: [.font: NSFont.systemFont(ofSize: 14)])
    let wrapped = AccessibilityTextAdapter().layoutRects(
        attributedText: paragraph, range: 0..<paragraph.length,
        elementFrame: CGRect(x: 50, y: 100, width: 150, height: 300),
        caret: 0, actualCaret: CGRect(x: 54, y: 104, width: 1, height: 18))
    check(wrapped.count >= 3, "shared TextKit preparation preserves every wrapped line")
    check(Set(wrapped.map(\.minY)).count == wrapped.count,
          "wrapped fallback fragments retain their separate vertical positions")
}

print("reference store")
do {
    let url = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("lasso-refs-\(UUID().uuidString).json")
    let store = DependencyReferenceStore(url: url)
    var reference = DependencyReference(
        id: "ref_1", objectId: "obj_1", versionId: "v1",
        hostBundleIdentifier: "com.google.Chrome", hostApplication: "Google Chrome",
        documentContext: "compose-1",
        anchor: TextAnchor(text: "office supplies", prefixContext: "cost of ",
                           suffixContext: " is", approximateOffset: 22),
        state: .healthy, label: "Office Supplies", valueText: "400",
        sourcePath: "Income-Statement.xlsx", sourceLocation: "Accounting!B21",
        sourceColorSlot: 2,
        createdAt: Date(), updatedAt: Date())
    reference.projectId = "directory-finance"

    // A cited video keeps its moment; a link saved before videos were cited has none.
    var videoReference = reference
    videoReference.videoTime = 4.92
    let encoded = try! JSONEncoder().encode(videoReference)
    var older = try! JSONSerialization.jsonObject(with: encoded) as! [String: Any]
    older.removeValue(forKey: "videoTime")
    check(try! JSONDecoder().decode(DependencyReference.self, from: encoded).videoTime == 4.92
          && (try? JSONDecoder().decode(DependencyReference.self,
                from: JSONSerialization.data(withJSONObject: older)))?.videoTime == nil,
          "a link remembers the second its video is cited at, and older links still load")

    // A link remembers the snapshot it was made at, and asks for that file.
    var pinnedReference = reference
    pinnedReference.snapshotId = "snapshot-7"
    var unpinned = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(pinnedReference)) as! [String: Any]
    unpinned.removeValue(forKey: "snapshotId")
    let unpinnedReference = try? JSONDecoder().decode(DependencyReference.self,
        from: JSONSerialization.data(withJSONObject: unpinned))
    check(try! JSONDecoder().decode(DependencyReference.self, from: JSONEncoder().encode(pinnedReference)).snapshotId
          == "snapshot-7" && unpinnedReference != nil && unpinnedReference?.snapshotId == nil,
          "a link remembers the snapshot it was made at, and older links still load")
    check(pinnedReference.citedVersionQuery == [URLQueryItem(name: "version", value: "v1"),
                                                URLQueryItem(name: "snapshot", value: "snapshot-7")]
          && reference.citedVersionQuery == [URLQueryItem(name: "version", value: "v1")],
          "a link asks for its version at the snapshot it was made at, when it knows it")

    // A word inserted with a share link previews that link as its recipient sees it.
    var sharedReference = reference
    sharedReference.shareToken = "token-redacted"
    var unshared = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(sharedReference)) as! [String: Any]
    unshared.removeValue(forKey: "shareToken")
    let unsharedReference = try? JSONDecoder().decode(DependencyReference.self,
        from: JSONSerialization.data(withJSONObject: unshared))
    check(try! JSONDecoder().decode(DependencyReference.self, from: JSONEncoder().encode(sharedReference)).shareToken
          == "token-redacted" && unsharedReference != nil && unsharedReference?.shareToken == nil,
          "a word inserted with a share link remembers it, and older links still load")
    check(sharedReference.sharedLinkQuery == [URLQueryItem(name: "share", value: "token-redacted")]
          && reference.sharedLinkQuery.isEmpty,
          "the inspector asks for the word's share link only when it was inserted with one")

    store.add(reference)
    check(store.references.count == 1, "stores a reference")
    check(store.hasReferences(bundleIdentifier: "com.google.Chrome"),
          "enables host observation only for applications with references")
    check(!store.hasReferences(bundleIdentifier: "com.apple.Safari"),
          "unrelated applications require no background Accessibility polling")
    check(store.references(forContext: "compose-1", bundleIdentifier: "com.google.Chrome").count == 1,
          "finds it by host document")
    check(store.references(forContext: "compose-2", bundleIdentifier: "com.google.Chrome").isEmpty,
          "never leaks into another document")
    check(store.references(forContext: "compose-1", bundleIdentifier: "com.apple.Safari").isEmpty,
          "never leaks into another application")

    let reloaded = DependencyReferenceStore(url: url)
    check(reloaded.references.count == 1, "survives a restart")
    check(reloaded.reference(id: "ref_1")?.sourceColorSlot == 2,
          "persists the source color identity")
    check(reloaded.reference(id: "ref_1")?.projectId == "directory-finance",
          "persists the source's owning directory across restart")
    var legacy = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(reference)) as! [String: Any]
    legacy.removeValue(forKey: "projectId")
    let oldReference = try! JSONDecoder().decode(DependencyReference.self,
        from: JSONSerialization.data(withJSONObject: legacy))
    check(oldReference.projectId == nil && oldReference.sourceColorSlot == 2,
          "legacy references without an owner still decode with their old color")
    check(reloaded.hasReferences(bundleIdentifier: "com.google.Chrome"),
          "restores host observation eligibility after restart")

    store.update(id: "ref_1") { $0.state = .changed }
    check(store.reference(id: "ref_1")?.state == .changed, "records a state change")

    store.update(id: "ref_1") { $0.state = .unresolved }
    let unresolvedRevision = store.revision
    let unresolvedTimestamp = store.reference(id: "ref_1")?.updatedAt
    let unresolvedData = try? Data(contentsOf: url)
    for _ in 0..<100 { store.update(id: "ref_1") { $0.state = .unresolved } }
    check(store.revision == unresolvedRevision, "repeated ambiguous refreshes do not mutate the store")
    check(store.reference(id: "ref_1")?.updatedAt == unresolvedTimestamp,
          "an unchanged unresolved state retains its timestamp")
    check((try? Data(contentsOf: url)) == unresolvedData,
          "an idle ambiguous reference does not rewrite persisted content")
    store.batchUpdates {
        store.update(id: "ref_1") { $0.state = .healthy }
        store.update(id: "ref_1") { $0.sourceColorSlot = 3 }
        check((try? Data(contentsOf: url)) == unresolvedData,
              "multiple changes defer persistence until the refresh is complete")
    }
    let batchReload = DependencyReferenceStore(url: url)
    check(batchReload.reference(id: "ref_1")?.state == .healthy
          && batchReload.reference(id: "ref_1")?.sourceColorSlot == 3,
          "batched updates persist the complete final reference")

    let cache = TextAnchorResolutionCache()
    let original = "The cost of office supplies is 400."
    let firstMatch = cache.resolve([reference], in: original)[reference.id]
    check(firstMatch == .resolved(12..<27), "anchor cache resolves the original document")
    let shifted = "Today: " + original
    check(cache.resolve([reference], in: shifted)[reference.id] == .resolved(19..<34),
          "editing a document invalidates cached offsets")
    var renamed = reference
    renamed.anchor = anchor(for: "cost", in: shifted)
    check(cache.resolve([renamed], in: shifted)[reference.id] == .resolved(11..<15),
          "changing an anchor invalidates a cache with unchanged document text")
    check(cache.resolve([], in: shifted).isEmpty, "unlinking removes cached matches")
    cache.clear()
    check(cache.resolve([reference], in: original)[reference.id] == firstMatch,
          "a new host snapshot resolves correctly after clearing cached text")

    store.remove(id: "ref_1")
    check(store.references.isEmpty, "removes on unlink")
    check(!store.hasReferences(bundleIdentifier: "com.google.Chrome"),
          "unlinking the last reference stops polling that host")
    check(DependencyReferenceStore(url: url).references.isEmpty, "removal persists")
    try? FileManager.default.removeItem(at: url)
}

print("claim-aware suggestion semantics")
do {
    let journalProfile = "journal id; inferred categorical variable; examples JE-0901, JE-0902, JE-0903, JE-0904, JE-0905, JE-0906"
    check(AssistSuggestionSemantics.insertionText(
        claimType: "STUDY_VARIABLE", label: "Journal ID", value: journalProfile,
        completionText: "journal_id") == "journal_id",
          "Tab inserts the explicit field name instead of its inferred profile and examples")
    check(AssistSuggestionSemantics.insertionText(
        claimType: "STUDY_VARIABLE", label: "Journal ID", value: journalProfile) == "Journal ID",
          "legacy variable candidates fall back to their name without inserting preview metadata")
    check(AssistSuggestionSemantics.insertionText(
        claimType: "STUDY_VARIABLE", label: "Journal ID", value: journalProfile,
        completionText: " \n ") == "Journal ID",
          "blank variable completions fall back to the name")
    check(AssistSuggestionSemantics.insertionText(
        claimType: "STUDY_VARIABLE", label: "", value: journalProfile,
        completionText: "") == "",
          "a malformed nameless variable is skipped rather than inserting its profile")
    check(AssistSuggestionSemantics.insertionText(
        claimType: "STUDY_VARIABLE", label: "Revenue", value: "Total sales before deductions.",
        completionText: "revenue") == "revenue",
          "data dictionary definitions remain preview details when accepting a variable name")
    check(AssistSuggestionSemantics.insertionText(
        claimType: "QUANTITATIVE", label: "October forecast CAD", value: "190000",
        completionText: "october_forecast_cad") == "190000",
          "numeric claims still insert the value when a field completion is also present")
    check(AssistSuggestionSemantics.insertionText(
        claimType: "STUDY_VARIABLE", label: "Revenue", value: "revenue; inferred numeric variable; examples 41, 5") == "Revenue",
          "variable acceptance inserts its name, never indexing diagnostics")
    let alert = "Alert when more than 75% of the pool is in use"
    check(AssistSuggestionSemantics.passage(of: ["valueText": alert, "label": "Alert when more than 75% of the pool is ",
                                                  "metadata": ["componentType": "TEXT_EXCERPT"]]) == alert,
          "a claimed sentence is the passage its preview marks, whole")
    check(AssistSuggestionSemantics.passage(of: ["valueText": "190000", "label": "October forecast CAD",
                                                  "metadata": ["componentType": "DATASET_CELL"]]) == nil,
          "a cell's value is not a passage to find in its preview")
    check(AssistSuggestionSemantics.passage(of: ["valueText": "  ", "metadata": ["componentType": "TEXT_EXCERPT"]]) == nil,
          "a blank sentence is no passage")
    check(AssistSuggestionSemantics.insertionText(
        claimType: "ENTITY", label: "Bad Debts/Losses and Thefts", value: "25") ==
          "Bad Debts/Losses and Thefts",
          "an entity claim inserts the indexed row name instead of a child cell value")
    check(AssistSuggestionSemantics.insertionText(
        claimType: "QUANTITATIVE", label: "Bad Debts/Losses and Thefts · Current Period", value: "25") == "25",
          "a quantitative claim still inserts the source-backed value")
}

print("CAD measurement locations")
do {
    check(AssistSourceLocation.cadFeature(label: "Bracket Ø8 hole depth", part: "Bracket") == "Ø8 hole depth",
          "a CAD measurement is located by the feature it measures")
    check(AssistSourceLocation.cadFeature(label: "Kitchen Area", part: nil) == "Kitchen Area"
            && AssistSourceLocation.cadFeature(label: "Bracketry Ø8 hole depth", part: "Bracket")
                == "Bracketry Ø8 hole depth",
          "a measurement label that does not start with its part is kept whole")
}

print("native workspace requests and errors")
do {
    let bodies = [WorkspaceAPI.addDirectoriesBody(["/tmp/Work"]),
                  WorkspaceAPI.toggleDirectoryBody(active: true),
                  WorkspaceAPI.toggleDirectoryBody(active: false)]
    for body in bodies {
        let data = try! JSONSerialization.data(withJSONObject: body)
        let decoded = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        let actor = decoded["actor"] as? [String: String]
        check(actor?["displayName"] == "Desktop" && actor?["actorType"] == "HUMAN_SELF"
              && actor?["id"] == "human:desktop",
              "directory actions send a valid human actor through JSON")
    }
    let url = URL(string: "http://127.0.0.1:4319/api/workspace")!
    let badRequest = HTTPURLResponse(url: url, statusCode: 400, httpVersion: nil, headerFields: nil)!
    let nested = Data(#"{"error":{"message":"Actor displayName is required."}}"#.utf8)
    check(WorkspaceAPI.errorMessage(data: nested, response: badRequest, error: nil)
          == "Actor displayName is required.", "the actual API error is shown")
    let legacy = Data(#"{"error":"Directory unavailable."}"#.utf8)
    check(WorkspaceAPI.errorMessage(data: legacy, response: badRequest, error: nil)
          == "Directory unavailable.", "plain-string server errors are still shown")
    check(WorkspaceAPI.errorMessage(data: Data("not JSON".utf8), response: badRequest, error: nil)
          == "The directory request failed (HTTP 400).", "invalid error bodies retain the HTTP status")
    let transport = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost,
                            userInfo: [NSLocalizedDescriptionKey: "Cannot connect to Lasso."])
    check(WorkspaceAPI.errorMessage(data: nil, response: nil, error: transport)
          == "Cannot connect to Lasso.", "connection failures retain their explanation")
    let removal = WorkspaceAPI.removeDirectoriesBody(["finance", "legal"])
    check(removal["projectIds"] as? [String] == ["finance", "legal"],
          "a bulk removal sends every selected directory id in one request")
}

print("selecting several directories before removing them")
do {
    let order = ["finance", "accountant", "residential", "commercial", "legal"]
    let empty = DirectorySelection()
    let one = empty.toggling("accountant", in: order)
    check(one.ids == ["accountant"] && empty.ids.isEmpty,
          "toggling selects a directory and leaves the previous selection unchanged")
    check(one.toggling("accountant", in: order).ids.isEmpty, "toggling a selected directory deselects it")
    let range = one.toggling("commercial", in: order, extendingRange: true)
    check(range.ids == ["accountant", "residential", "commercial"],
          "shift-clicking selects every directory between the last choice and this one")
    let upward = DirectorySelection().toggling("residential", in: order)
        .toggling("finance", in: order, extendingRange: true)
    check(upward.ids == ["finance", "accountant", "residential"], "a range can extend upward too")
    let all = empty.selectingAll(order)
    check(all.ids == Set(order) && all.containsAll(order), "Select All chooses every directory")
    check(!one.containsAll(order) && !empty.containsAll([]), "a partial or empty list is not fully selected")
    check(all.pruned(to: ["legal", "finance"]).ids == ["legal", "finance"],
          "directories that disappear are dropped from the selection")
    check(all.ordered(order) == order, "a removal lists directories in the order they appear")
    check(WorkspaceAPI.removalCommandTitle(count: 0) == "Remove Selected Directories",
          "the remove command reads plainly before anything is selected")
    check(WorkspaceAPI.removalCommandTitle(count: 1) == "Remove 1 Directory\u{2026}"
          && WorkspaceAPI.removalCommandTitle(count: 3) == "Remove 3 Directories\u{2026}",
          "the remove command counts the selection")
    let single = WorkspaceAPI.removalConfirmation(names: ["Finance"])
    check(single.message == "Remove \u{201C}Finance\u{201D} from Lasso?"
          && single.details.contains("The folder and its files will remain on your Mac"),
          "removing one directory names it and says its files stay")
    let many = WorkspaceAPI.removalConfirmation(names: ["A", "B", "C", "D", "E", "F", "G"])
    check(many.message == "Remove 7 directories from Lasso?"
          && many.details.contains("A, B, C, D, E and 2 more")
          && many.details.contains("The folders and their files will remain on your Mac"),
          "removing several directories names the first few and counts the rest")
    check(WorkspaceAPI.removalConfirmation(names: ["A", "B"]).details.contains("A and B"),
          "two directories are named together")
    let folders = [(name: "Notes", path: "/Work/Notes"), (name: "Notes", path: "/Home/Notes"),
                   (name: "Legal", path: "/Work/Legal")]
    check(WorkspaceAPI.distinctNames(folders) == ["/Work/Notes", "/Home/Notes", "Legal"],
          "folders sharing a name are told apart by their path, as in the list")

    let listed = [(id: "legal", on: false), (id: "finance", on: true), (id: "health", on: false), (id: "cad", on: true)]
    check(WorkspaceAPI.switchedOnFirst(listed, isOn: \.on).map(\.id) == ["finance", "cad", "legal", "health"],
          "directories that are on are listed above those that are off, each group in its usual order")
    check(WorkspaceAPI.fixDirectoryPath("abc") == "api/workspace/directories/abc/fix"
          && WorkspaceAPI.fixDirectoryBody()["actor"] != nil,
          "the Fix button asks the server to fix that folder")
}

print("a directory's issue badge reads the server's description")
do {
    let fixable = DirectoryIssue(["kind": "READER", "message": "Lasso's file reader has improved.",
                                  "fix": ["label": "Re-read Files"]])
    check(fixable?.message == "Lasso's file reader has improved." && fixable?.fixLabel == "Re-read Files",
          "an issue Lasso caused carries its fix")
    let described = DirectoryIssue(["kind": "UNAVAILABLE", "message": "Lasso can't find this folder.", "fix": NSNull()])
    check(described?.fixLabel == nil && described?.message == "Lasso can't find this folder.",
          "an issue Lasso did not cause has no fix")
    check(DirectoryIssue(nil) == nil && DirectoryIssue(NSNull()) == nil && DirectoryIssue(["message": ""]) == nil,
          "a healthy folder shows no badge")
}

print("directory operations keep their loading bar visible until the response arrives")
do {
    _ = NSApplication.shared
    func descendants(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap(descendants)
    }
    let controller = StatusPopoverController()
    let pending = NSMenu()
    let status = NSMenuItem(title: "Re-read Files: CAD models…", action: nil, keyEquivalent: "")
    let progressRow = NativeMenuProgressRow(item: status)
    status.view = progressRow
    pending.addItem(status)
    let settings = NSMenuItem(title: "Settings", action: nil, keyEquivalent: "")
    settings.submenu = NSMenu()
    settings.submenu?.addItem(NSMenuItem(title: "Appearance", action: nil, keyEquivalent: ""))
    pending.addItem(settings)
    for index in 1...32 { pending.addItem(NSMenuItem(title: "Directory status \(index)", action: nil, keyEquivalent: "")) }
    controller.update(menu: pending)
    let root = controller.popover.contentViewController!.view
    let progress = descendants(root).compactMap { $0 as? DirectoryProgressBar }.first
    check(progress != nil && progress?.indeterminate == true && progress?.accessibilityRole() == .progressIndicator,
          "a pending directory operation displays an honest indeterminate loading bar")
    check(progress?.accessibilityLabel() == status.title,
          "the loading bar names the directory operation to VoiceOver")
    check(progress != nil && progress!.frame.width > 200 && progressRow.bounds.contains(progress!.frame),
          "the bar has visible width and remains inside its row after menu layout")
    let scroll = root.subviews.compactMap { $0 as? NSScrollView }.first!
    scroll.contentView.scroll(to: NSPoint(x: 0, y: 160))
    check(scroll.contentView.bounds.origin.y > 0, "the operation can start below a long menu's fold")
    controller.revealProgress()
    check(scroll.contentView.bounds.origin.y == 0,
          "starting repair brings progress into view after the issue card closes")
    let settingsButton = descendants(root).compactMap { $0 as? NSButton }.first { $0.title == "Settings" }
    settingsButton?.performClick(nil)
    check(settingsButton != nil && descendants(root).contains { $0 === progressRow },
          "expanding settings during a request preserves the loading bar")
    let complete = NSMenu()
    complete.addItem(NSMenuItem(title: "Lasso · 3 active directories", action: nil, keyEquivalent: ""))
    controller.update(menu: complete)
    check(!descendants(root).contains { $0 is DirectoryProgressBar } && progressRow.superview == nil,
          "completion removes the loading bar instead of leaving a stuck operation")
    let failure = NSMenu()
    failure.addItem(NSMenuItem(title: "The directory could not be read.", action: nil, keyEquivalent: ""))
    controller.update(menu: failure)
    check(!descendants(root).contains { $0 is DirectoryProgressBar },
          "the error state shows its message without retaining progress")
}

print("a folder being read reports its progress as the server describes it")
do {
    let reported = DirectoryProgress(["kind": "adding", "phase": "reading", "percent": NSNumber(value: 37)])
    check(reported?.percent == 37 && reported?.activity == "Reading files",
          "the row reads the server's percentage and what the folder is doing")
    check(DirectoryProgress(["kind": "rereading", "phase": "indexing", "percent": 140])?.percent == 100
          && DirectoryProgress(["percent": -4])?.percent == 0,
          "a percentage outside 0 to 100 is held inside it")
    check(DirectoryProgress(["kind": "rereading", "phase": "indexing", "percent": 5])?.activity == "Re-reading files",
          "a re-read says so")
    check(DirectoryProgress(nil) == nil && DirectoryProgress(["phase": "reading"]) == nil,
          "a folder that is not being read shows no bar")
    check(WorkspaceAPI.stateURL(base: URL(string: "http://127.0.0.1:4319/")!)?.absoluteString
          == "http://127.0.0.1:4319/api/workspace?pending=1",
          "the menu asks for folders still being added, so they are listed from the start")
}

print("the percentage counts up one percent after another and never runs ahead")
do {
    let counter = ProgressCounter()
    var shown: [Int] = []
    counter.onChange = { shown.append(Int($0.rounded(.down))) }
    counter.move(to: 12, animated: false)
    check(counter.shown == 12 && !counter.isCounting, "off screen the count takes the value at once")
    counter.move(to: 20, animated: true)
    check(counter.isCounting, "a later report is counted towards on screen")
    for _ in 0..<600 where counter.isCounting { counter.advance(by: 1.0 / 60) }
    check(counter.shown == 20 && !counter.isCounting, "the count stops at the report, never past it")
    let counted = Array(Set(shown.filter { $0 > 12 })).sorted()
    check(counted == Array(13...20), "every percent from 13 to 20 is shown on the way: \(counted)")
    counter.move(to: 15, animated: true)
    check(counter.shown == 20 && counter.target == 20 && !counter.isCounting, "the bar never moves back")
    let wide = ProgressCounter()
    wide.move(to: 0, animated: false)
    wide.move(to: 90, animated: true)
    var frames = 0
    while wide.isCounting && frames < 600 { wide.advance(by: 1.0 / 60); frames += 1 }
    check(frames > 20 && frames < 90, "a wide jump plays as a quick count, not a leap or a crawl (\(frames) frames)")
    wide.stop()
}

print("the card's highlight after a new answer")
do {
    let shown = ["BILL-1160", "BILL-1174", "BILL-1181"]
    let reordered = ["BILL-1174", "BILL-1160", "BILL-1181"]
    check(CardHighlight.afterAnswer(selected: 1, previous: shown, next: reordered, textChanged: true) == 0,
          "typing starts the highlight again at the top, where the closest match is")
    check(CardHighlight.afterAnswer(selected: 1, previous: shown, next: reordered, textChanged: false) == 0,
          "an answer to the same text keeps the highlighted suggestion wherever it moved")
    check(CardHighlight.afterAnswer(selected: 2, previous: shown, next: shown, textChanged: false) == 2,
          "an unchanged list keeps its highlighted row")
    check(CardHighlight.afterAnswer(selected: 2, previous: shown, next: ["BILL-1160"], textChanged: false) == 0,
          "a shorter list without it keeps the highlight in range")
    check(CardHighlight.afterAnswer(selected: 0, previous: [], next: [], textChanged: false) == 0, "nothing to highlight stays at the top")
}

print("a share keeps the sentence its citation sits in")
check(CitingSentence.around("$46,350", before: "Revenue rose. Net income was ", after: " for September. Costs fell.")
      == "Net income was $46,350 for September.", "the sentence runs from the last sentence end to the next")
check(CitingSentence.around("17250", before: "Cedar Packaging is owed ", after: "")
      == "Cedar Packaging is owed 17250", "a sentence still being written ends at the citation")
check(CitingSentence.around("BILL-1192", before: "Notes\nInvoice ", after: " is paid\nNext")
      == "Invoice BILL-1192 is paid", "a line break ends a sentence too")

print("a folder's switch is drawn in the folder's own colour, which follows a new pick")
do {
    _ = NSApplication.shared
    func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
    func distance(_ first: NSColor, _ second: NSColor) -> CGFloat {
        guard let a = first.usingColorSpace(.sRGB), let b = second.usingColorSpace(.sRGB) else { return .infinity }
        return abs(a.redComponent - b.redComponent) + abs(a.greenComponent - b.greenComponent)
            + abs(a.blueComponent - b.blueComponent)
    }
    let accent = NSColor.controlAccentColor
    // The folder colour least like the system accent, so the two cannot be mistaken.
    let folder = DirectoryToggleColor.allCases.max { distance($0.color, accent) < distance($1.color, accent) }!
    let item = NSMenuItem(title: "Budget", action: nil, keyEquivalent: "")
    item.state = .on
    let row = NativeMenuToggleRow(item: item, color: folder) { _ in }
    let toggle = descendants(row).first { ($0 as? NSButton)?.accessibilitySubrole() == .switch }!
    toggle.appearance = NSAppearance(named: .aqua)
    let picture = toggle.bitmapImageRepForCachingDisplay(in: toggle.bounds)!
    toggle.cacheDisplay(in: toggle.bounds, to: picture)
    let scale = CGFloat(picture.pixelsWide) / toggle.bounds.width
    // Left of the knob, inside the track of a switch that is on.
    let track = picture.colorAt(x: Int(10 * scale), y: Int(toggle.bounds.midY * scale))!
    check(distance(track, folder.color) < distance(track, accent),
          "the on switch reads as \(folder.title) (\(track)), not the system accent")
    row.update(item: item, color: .blue)
    toggle.cacheDisplay(in: toggle.bounds, to: picture)
    let repicked = picture.colorAt(x: Int(10 * scale), y: Int(toggle.bounds.midY * scale))!
    check(distance(repicked, DirectoryToggleColor.blue.color) < distance(repicked, folder.color),
          "a folder given a new colour has its switch redrawn in it")
}

print("a folder's row shows its progress in place of its switch, then gives the switch back")
do {
    _ = NSApplication.shared
    func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
    let item = NSMenuItem(title: "Multiple Cause Mortality", action: nil, keyEquivalent: "")
    item.image = NSImage(systemSymbolName: "folder", accessibilityDescription: nil)
    item.isEnabled = false
    let row = NativeMenuToggleRow(item: item, color: .blue) { _ in }
    row.frame.size.width = 296
    let toggle = descendants(row).first { $0 is DirectoryTintSwitch }!
    check(!row.isShowingProgress && !toggle.isHidden, "a folder at rest shows its switch")
    row.progress = DirectoryProgress(percent: 0, phase: "waiting", kind: "adding")
    let bar = row.progressBarView
    check(row.isShowingProgress && toggle.isHidden && bar.accessibilityRole() == .progressIndicator,
          "a folder being added shows a determinate bar where its switch was")
    check(row.percentText == "0%" && bar.value == 0, "it starts at 0%")
    let name = descendants(row).compactMap { $0 as? NSTextField }.first { $0.stringValue == item.title }
    check(name?.textColor == .labelColor, "the folder being read is not dimmed, though it cannot be switched")
    check(bar.frame.width > 200 && row.bounds.contains(bar.frame), "the bar spans the row under the folder's name")
    row.progress = DirectoryProgress(percent: 41, phase: "indexing", kind: "adding")
    check(row.percentText == "41%" && bar.value == 41, "a later report moves the bar and the count")
    check(bar.accessibilityValue() as? String == "41 percent" && (row.toolTip ?? "").hasPrefix("Indexing files"),
          "VoiceOver and the tooltip say how far the folder has got")
    row.progress = DirectoryProgress(percent: 30, phase: "warming", kind: "adding")
    check(row.percentText == "41%", "an earlier report does not move the bar back")
    row.progress = nil
    check(!row.isShowingProgress && !toggle.isHidden && row.percentText == "100%",
          "when the folder is ready the bar completes and the switch returns")
    check(name?.textColor == .disabledControlTextColor, "then it reads as its menu item does")
    row.progress = DirectoryProgress(percent: 6, phase: "indexing", kind: "rereading")
    check(row.isShowingProgress && row.percentText == "6%" && bar.value == 6,
          "a re-read after a finished run counts from 0% again, not from the last run's 100%")
    let percent = descendants(row).compactMap { $0 as? NSTextField }.first { $0.stringValue == "6%" }!
    check(percent.frame.minX > bar.frame.maxX && abs(percent.frame.midY - bar.frame.midY) < 3,
          "the percentage sits to the right of the bar, on its line")
    row.progress = nil

    // A new run that arrives while the last one is still finishing on screen.
    let finishing = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 296, height: 40), styleMask: [.borderless],
                             backing: .buffered, defer: true)
    finishing.contentView?.addSubview(row)
    row.progress = DirectoryProgress(percent: 90, phase: "indexing", kind: "rereading")
    for _ in 0..<600 where row.progressCounter.isCounting { row.progressCounter.advance(by: 1.0 / 60) }
    row.progress = nil
    for _ in 0..<600 where row.progressCounter.isCounting { row.progressCounter.advance(by: 1.0 / 60) }
    row.progress = DirectoryProgress(percent: 2, phase: "indexing", kind: "rereading")
    let restarted = row.progressCounter.target == 2 && row.progressCounter.shown <= 2
    for _ in 0..<600 where row.progressCounter.isCounting { row.progressCounter.advance(by: 1.0 / 60) }
    check(restarted && row.percentText == "2%",
          "a run that starts while the last is finishing begins at 0% too")
    row.removeFromSuperview()

    let controller = StatusPopoverController()
    func menu(_ percent: Int?) -> NSMenu {
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Adding Multiple Cause Mortality\u{2026}", action: nil, keyEquivalent: ""))
        let entry = NSMenuItem(title: "Multiple Cause Mortality", action: nil, keyEquivalent: "")
        entry.representedObject = "mcm"
        entry.isEnabled = false
        let fresh = NativeMenuToggleRow(item: entry, color: .blue) { _ in }
        fresh.progress = percent.map { DirectoryProgress(percent: $0, phase: "reading", kind: "adding") }
        entry.view = fresh
        menu.addItem(entry)
        return menu
    }
    controller.update(menu: menu(10))
    let root = controller.popover.contentViewController!.view
    let shown = descendants(root).compactMap { $0 as? NativeMenuToggleRow }.first!
    check(shown.isShowingProgress && shown.percentText == "10%", "the menu lists the folder with its progress")
    check(!descendants(root).contains { ($0 as? DirectoryProgressBar)?.indeterminate == true },
          "the status line has no second, indeterminate bar while a folder shows its own")
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 200), styleMask: [.borderless],
                          backing: .buffered, defer: true)
    window.contentView?.addSubview(root)
    controller.update(menu: menu(55))
    let reused = descendants(root).compactMap { $0 as? NativeMenuToggleRow }.first!
    check(reused === shown && reused.progressCounter.target == 55,
          "the next report reaches the same row, so the count carries on from where it was")
    // With Reduce Motion the count takes each report at once, as it should.
    check(NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
          || (reused.progressCounter.isCounting && reused.percentText == "10%"),
          "a report that arrives while the menu rebuilds its rows is counted towards, not jumped to")
    for _ in 0..<600 where reused.progressCounter.isCounting { reused.progressCounter.advance(by: 1.0 / 60) }
    check(reused.percentText == "55%", "and the count arrives there")
    root.removeFromSuperview()
}

print("the colour picker lays its colours out in a capsule, the chosen one a named pill")
do {
    let dots = Array(repeating: PaletteMetric.swatch, count: DirectoryToggleColor.allCases.count)
    let frames = PaletteLayout.frames(widths: dots, origin: CGPoint(x: 10, y: 2))
    check(frames.first?.minX == 10 + PaletteMetric.inset && frames.first?.minY == 2 + PaletteMetric.inset
          && zip(frames, frames.dropFirst()).allSatisfy { $1.minX - $0.maxX == PaletteMetric.gap },
          "the colours sit in a row inside the capsule, an even gap apart")
    check(PaletteLayout.trackWidth(widths: dots) == frames.last!.maxX + PaletteMetric.inset - 10,
          "the capsule ends as far past the last colour as it starts before the first")
    check(PaletteLayout.pillWidth(nameWidth: 12) == PaletteMetric.pillMinimum, "a short name still makes a pill")
    check(PaletteLayout.pillWidth(nameWidth: 60) >= 60 + PaletteMetric.labelLeading + PaletteMetric.close,
          "a long name and the close button both fit in the pill")
    check(PaletteLayout.width(selected: false, hovered: true, pill: 70, reduceMotion: false) == PaletteMetric.hoverWidth
          && PaletteLayout.width(selected: false, hovered: false, pill: 70, reduceMotion: false) == PaletteMetric.swatch,
          "pointing at a colour widens it into a short capsule")
    check(PaletteLayout.width(selected: false, hovered: true, pill: 70, reduceMotion: true) == PaletteMetric.swatch
          && PaletteLayout.width(selected: true, hovered: false, pill: 70, reduceMotion: true) == 70,
          "with Reduce Motion pointing moves nothing, and the chosen colour is still the pill")
    var widened = dots
    widened[2] = PaletteMetric.hoverWidth
    let wide = PaletteLayout.frames(widths: widened, origin: .zero)
    check(PaletteLayout.hovered(at: CGPoint(x: wide[2].maxX - 1, y: wide[2].midY), frames: wide) == 2,
          "the pointer at the end of a widened colour is still on it, so it does not flicker")
    check(PaletteLayout.hovered(at: CGPoint(x: wide[2].maxX + PaletteMetric.gap / 2 + 0.5, y: wide[2].midY), frames: wide) == 3
          && PaletteLayout.hovered(at: CGPoint(x: wide.last!.maxX + 10, y: wide[2].midY), frames: wide) == nil,
          "past the middle of a gap it is on the next colour, and beside the capsule on none")
    check(PaletteLayout.darkText(on: DirectoryToggleColor.orange.color) && !PaletteLayout.darkText(on: DirectoryToggleColor.blue.color),
          "orange carries dark letters and blue light ones, so every name reads")
    check(PaletteMotion.letterStart(0, reduceMotion: false) > 0
          && PaletteMotion.letterStart(3, reduceMotion: false) > PaletteMotion.letterStart(2, reduceMotion: false),
          "the name comes in a letter at a time, once the pill has started to stretch")
    check(PaletteMotion.letterStart(4, reduceMotion: true) == 0, "with Reduce Motion the name comes in whole")
    var stretch = IslandSpring(Double(PaletteMetric.swatch), stiffness: PaletteMotion.width.stiffness,
                               damping: PaletteMotion.width.damping)
    stretch.t = 70
    var time = 0.0, peak = stretch.x
    var settled: Double?
    while time < 1.5 {
        stretch.step(1.0 / 480)
        time += 1.0 / 480
        peak = max(peak, stretch.x)
        if abs(stretch.x - 70) >= 0.5 { settled = nil } else if settled == nil { settled = time }
    }
    check(peak < 70.5, "a colour stretches into the pill without a visible overshoot")
    check((settled ?? .infinity) < 0.4, "and gets there in under 0.4 seconds, as in the reference")
}

print("choosing in the colour picker stretches the new colour and types its name in")
do {
    _ = NSApplication.shared
    var now = 50.0
    var picked: [DirectoryToggleColor] = []
    let palette = DirectoryColorPaletteRow(selected: .purple) { picked.append($0) }
    palette.frame.size.width = 284
    palette.drivesItself = false
    palette.animatesOffscreen = true
    palette.reducesMotion = { false }
    palette.clock = { now }
    var rooms: [CGFloat] = []
    palette.onRoom = { rooms.append($0) }
    func run(_ seconds: Double) {
        let end = now + seconds
        while now < end - 1e-9 {
            now += 1.0 / 120
            palette.tick()
        }
    }
    check(!palette.isOpen && rooms.isEmpty, "a new picker is closed until it is opened")
    palette.open()
    run(0.05)
    check((rooms.last ?? 0) > 0 && (rooms.last ?? 32) < 32, "opening grows the row on a spring")
    run(1)
    check(rooms.contains { $0 > 32.3 } && abs((rooms.last ?? 0) - 32) < 0.01 && palette.isAtRest(at: now),
          "it overshoots a little, as the panel's add control does, and comes to rest open")
    let purple = palette.swatches.first { $0.tint == .purple }!
    let green = palette.swatches.first { $0.tint == .green }!
    check(purple.accessibilityLabel() == "Use Purple" && purple.accessibilityValue() as? String == "Purple, selected"
          && green.accessibilityValue() as? String == "Green", "VoiceOver hears each colour and which one is chosen")
    check(palette.letterOpacities(.purple).allSatisfy { $0 == 1 } && palette.closeOpacity == 1,
          "the chosen colour is named, with its close button")
    green.performClick(nil)
    check(picked == [.green] && green.accessibilityValue() as? String == "Green, selected",
          "choosing a colour hands it on at once")
    run(0.04)
    let midway = palette.shownWidths
    check(midway[2] > PaletteMetric.swatch && midway[2] < palette.targetWidths[2]
          && midway[5] > PaletteMetric.swatch && midway[5] < palette.targetWidths[2],
          "the new colour stretches while the old pill shrinks back")
    check(palette.letterOpacities(.purple).allSatisfy { $0 < 0.5 } && palette.letterOpacities(.green).allSatisfy { $0 == 0 },
          "the old name goes at once, and the new one waits for the pill")
    run(0.12)
    let letters = palette.letterOpacities(.green)
    check(letters.first! > 0.3 && letters.first! > letters.last!, "the new name comes in from its first letter")
    run(1)
    check(palette.shownWidths[2] == palette.targetWidths[2] && palette.targetWidths[2] >= PaletteMetric.pillMinimum
          && palette.shownWidths[5] == PaletteMetric.swatch, "the new colour ends as the pill and the old one as a dot")
    check(palette.letterOpacities(.green).allSatisfy { $0 == 1 } && palette.letterOpacities(.purple).allSatisfy { $0 == 0 },
          "only the chosen colour is named")
    let closeFrame = palette.closeButton.frame
    check(palette.closeOpacity == 1 && closeFrame.maxX <= green.frame.maxX
          && closeFrame.minX >= green.frame.minX + PaletteMetric.labelLeading + green.nameWidth,
          "the close button moves to the end of the new pill, clear of the name")
    let first = palette.swatches[0]
    palette.pointer(at: palette.convert(NSPoint(x: first.frame.midX, y: first.frame.midY), from: first.superview))
    run(1)
    check(palette.shownWidths[0] == PaletteMetric.hoverWidth, "pointing at a colour widens it")
    palette.pointer(at: nil)
    run(1)
    check(palette.shownWidths[0] == PaletteMetric.swatch, "and it narrows again when the pointer leaves")
    var closed = false
    palette.onClose = { palette.close() }
    palette.onClosed = { closed = true }
    palette.closeButton.performClick(nil)
    run(0.05)
    check(!closed && (rooms.last ?? 32) < 32, "the close button shrinks the row back")
    run(1)
    check(closed && rooms.last == 0, "then the picker says it has closed")
}

print("a folder's colour button opens the picker under its row, and choosing works as before")
do {
    _ = NSApplication.shared
    func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
    var chosen: [DirectoryToggleColor] = []
    let item = NSMenuItem(title: "Thesis", action: nil, keyEquivalent: "")
    item.state = .on
    let row = NativeMenuToggleRow(item: item, color: .blue) { chosen.append($0) }
    row.frame.size.width = 284
    let dot = descendants(row).compactMap { $0 as? DirectoryColorButton }.first!
    dot.performClick(nil)
    check(row.isPaletteVisible && row.frame.height == 64 && row.paletteView != nil,
          "the colour button opens the picker; a row nobody can see is open at once")
    row.paletteView!.swatches.first { $0.tint == .pink }!.performClick(nil)
    check(chosen == [.pink] && row.currentColor == .pink, "choosing in the picker colours the folder")
    row.paletteView!.closeButton.performClick(nil)
    check(!row.isPaletteVisible && row.frame.height == 32 && row.paletteView == nil, "its close button puts the picker away")
    dot.performClick(nil)
    dot.performClick(nil)
    check(row.frame.height == 32 && row.paletteView == nil, "the colour button puts it away too")

    var now = 10.0
    row.preparePalette = { palette in
        palette.drivesItself = false
        palette.animatesOffscreen = true
        palette.reducesMotion = { false }
        palette.clock = { now }
    }
    var resized = 0
    row.onSizeChange = { resized += 1 }
    row.setPaletteVisible(true)
    let animated = row.paletteView!
    check(row.frame.height == 32, "on screen the row starts at its own height")
    for _ in 0..<120 { now += 1.0 / 120; animated.tick() }
    check(row.frame.height == 64 && resized > 2 && animated.frame.height == 32,
          "and grows frame by frame to make room for the picker")
    row.setPaletteVisible(false)
    for _ in 0..<4 { now += 1.0 / 120; animated.tick() }
    row.setPaletteVisible(true)
    check(row.paletteView === animated, "opening it again while it closes turns the same picker around")
    for _ in 0..<240 { now += 1.0 / 120; animated.tick() }
    check(row.frame.height == 64 && row.isPaletteVisible, "and it settles open")
    animated.plusButton.performClick(nil)
    for _ in 0..<240 { now += 1.0 / 120; animated.tick() }
    let cardRoom = PaletteMetric.trackHeight + PaletteCardLayout.height(width: animated.trackFrame.width) + 4
    check(abs(row.frame.height - (32 + cardRoom.rounded())) <= 1 && animated.trackFrame.maxX <= row.frame.width - 2,
          "pressing + grows the row to hold the card, which stays inside the row")
    animated.plusButton.performClick(nil)
    for _ in 0..<240 { now += 1.0 / 120; animated.tick() }
    check(row.frame.height == 64 && chosen == [.pink], "its × puts the card away, and nothing new was chosen")
}

print("a folder colour can be one of Lasso's six or a hex of one's own")
do {
    check(DirectoryToggleColor(rawValue: "purple") == .purple && DirectoryToggleColor.purple.title == "Purple"
          && !DirectoryToggleColor.purple.isCustom, "colours saved by name still read back as Lasso's own")
    let own = DirectoryToggleColor(rawValue: "#3c7a28")
    check(own?.rawValue == "#3C7A28" && own?.title == "#3C7A28" && own?.isCustom == true,
          "a hex is a colour of one's own, written in capitals")
    check(DirectoryToggleColor(rawValue: "#12345") == nil && DirectoryToggleColor(rawValue: "red") == nil,
          "anything else is not a colour")
    let made = DirectoryToggleColor(red: 0.2, green: 0.4, blue: 0.6)
    check(made.rawValue == "#336699" && abs(made.components.green - 0.4) < 0.003, "a made colour keeps its components")
    check(DirectoryToggleColor(rawValue: DirectoryToggleColor.orange.hex)?.matchingPreset == .orange
          && made.matchingPreset == nil, "a hex that is one of Lasso's colours is known as that colour")
    check(DirectoryToggleColor.choices(including: made, nil, .blue) == DirectoryToggleColor.allCases + [made],
          "a menu of colours lists Lasso's six, then a colour of one's own in use")
    let defaults = MemoryDirectoryDefaults()
    DirectoryColorPreferences.set(made, for: "thesis", defaults: defaults)
    check(DirectoryColorPreferences.color(for: "thesis", defaults: defaults) == made,
          "a folder keeps a colour of one's own")
    DirectoryColorPreferences.rememberCustom(.green, defaults: defaults)
    check(DirectoryColorPreferences.lastCustom(defaults) == nil, "only colours of one's own are remembered as made")
    DirectoryColorPreferences.rememberCustom(made, defaults: defaults)
    check(DirectoryColorPreferences.lastCustom(defaults) == made, "the last colour made is offered to every folder")

    let purple = PaletteHSB(.purple)
    check(purple.color == DirectoryToggleColor(rawValue: DirectoryToggleColor.purple.hex),
          "hue, saturation and brightness go back to the same colour")
    let grey = PaletteHSB(hue: 0.7, saturation: 0, brightness: 0.5)
    check(grey.hue == 0.7 && grey.color.rawValue == "#808080", "a grey keeps the hue it was dragged from")
    let shades = PaletteShades.shades(hue: 0.3)
    check(shades.count == 9 && shades.allSatisfy { $0.hue == 0.3 }
          && zip(shades, shades.dropFirst()).allSatisfy { $0.brightness >= $1.brightness },
          "the shades are of the one hue, palest first")
    check(PaletteShades.index(of: shades[4]) == 4 && PaletteShades.index(of: PaletteHSB(.blue)) == nil,
          "the ring finds the shade the colour is, and none when it is not a shade")
    check(abs(PaletteContrast.ratio(.black, .white) - 21) < 0.01 && PaletteContrast.grade(21) == "AAA"
          && PaletteContrast.grade(5) == "AA" && PaletteContrast.grade(2) == "Low",
          "contrast is measured and graded as WCAG does")
    let width: CGFloat = 258
    let field = PaletteCardLayout.field(width: width), hue = PaletteCardLayout.hue(width: width)
    let row = PaletteCardLayout.shades(width: width), footer = PaletteCardLayout.footer(width: width)
    check(field.minX == hue.minX && hue.minY > field.maxY && row[0].minY > hue.maxY && footer.minY > row[0].maxY
          && abs(row.last!.maxX - field.maxX) < 0.01 && PaletteCardLayout.height(width: width) > footer.maxY,
          "the card stacks field, hue, shades and footer, all the same width")
    check(PaletteLayout.trackWidth(widths: [20, 0, 20]) == 2 * PaletteMetric.inset + 40 + PaletteMetric.gap
          && PaletteLayout.frames(widths: [20, 0, 20], origin: .zero)[2].minX == PaletteMetric.inset + 20 + PaletteMetric.gap,
          "a colour not there takes no room and leaves no gap")
    check(PaletteLayout.width(selected: false, hovered: true, pill: 70, reduceMotion: false, hoverRoom: 3)
          == PaletteMetric.swatch + 3, "pointing widens a colour only as far as the row has room")
}

print("the + makes a colour of one's own in a card, and Done keeps it")
do {
    _ = NSApplication.shared
    var now = 80.0
    var picked: [DirectoryToggleColor] = []
    let palette = DirectoryColorPaletteRow(selected: .purple) { picked.append($0) }
    palette.frame.size.width = 274
    palette.drivesItself = false
    palette.animatesOffscreen = true
    palette.reducesMotion = { false }
    palette.clock = { now }
    var rooms: [CGFloat] = []
    palette.onRoom = { rooms.append($0) }
    func run(_ seconds: Double) {
        let end = now + seconds
        while now < end - 1e-9 {
            now += 1.0 / 120
            palette.tick()
        }
    }
    palette.open()
    run(1)
    let slot = palette.swatches[palette.slotIndex]
    check(slot.isHidden && palette.shownWidths[palette.slotIndex] == 0 && !palette.plusButton.isHidden
          && palette.plusButton.accessibilityLabel() == "New custom color",
          "with no colour of one's own yet there is no slot, only the black +")
    check(palette.trackFrame.maxX <= 274 - PaletteMetric.trailingRoom, "the capsule fits the narrowest folder row")
    palette.plusButton.performClick(nil)
    run(0.05)
    check(palette.shownWidths[palette.slotIndex] > 0 && palette.shownWidths[palette.slotIndex] < palette.targetWidths[palette.slotIndex]
          && palette.plusTurn > 0 && palette.cardOpenness > 0, "pressing + grows a new pill in, turns the +, and opens the card")
    run(1)
    let start = DirectoryToggleColor(rawValue: DirectoryToggleColor.purple.hex)!
    check(palette.draft != nil && slot.tint == start && palette.selected == start && slot.accessibilityValue() as? String == "\(start.title), selected",
          "the new pill starts as a copy of the chosen colour, named by its hex")
    check(palette.letterOpacities(start).count == 7 && palette.letterOpacities(start).allSatisfy { $0 == 1 }
          && palette.letterOpacities(.purple).allSatisfy { $0 == 0 }, "its hex has typed in and the old name gone")
    check(abs(palette.plusTurn - 1) < 0.01 && palette.plusButton.accessibilityLabel() == "Cancel custom color"
          && abs((rooms.last ?? 0) - (PaletteMetric.trackHeight + PaletteCardLayout.height(width: palette.trackFrame.width) + 4)) < 0.5,
          "the + has turned into × and the row holds the whole card")
    check(palette.closeButton.isHidden && picked.isEmpty, "while it is being made the pill has no ×, and nothing is chosen yet")
    palette.card.hueSlider.onChange?(0.33)
    palette.card.field.onChange?(0.7, 0.6)
    let made = PaletteHSB(hue: 0.33, saturation: 0.7, brightness: 0.6).color
    check(slot.tint == made && palette.card.hsb.saturation == 0.7, "the pill follows the card's controls")
    palette.card.doneButton.performClick(nil)
    run(1)
    check(picked == [made] && palette.selected == made && palette.slotColor == made && palette.draft == nil,
          "Done chooses the colour made and keeps it in the slot")
    check(palette.cardOpenness < 0.01 && abs((rooms.last ?? 0) - 32) < 0.5 && palette.closeOpacity == 1,
          "the card goes away and the pill has its × again")

    palette.plusButton.performClick(nil)
    run(1)
    palette.card.shadeButtons[1].performClick(nil)
    palette.card.doneButton.performClick(nil)
    run(1)
    let pale = PaletteShades.shades(hue: palette.card.hsb.hue)[1].color
    check(palette.selected == pale && palette.closeButton.ink == NSColor.black.withAlphaComponent(0.78),
          "a pale colour made gets dark letters, and its × is dark too")
    palette.plusButton.performClick(nil)
    run(1)
    palette.card.field.onChange?(0.1, 0.9)
    palette.plusButton.performClick(nil)
    run(1)
    check(picked == [made, pale] && palette.selected == pale && slot.tint == pale,
          "the × puts the card away and goes back to the colour the folder had")
    palette.plusButton.performClick(nil)
    run(1)
    palette.swatches[0].performClick(nil)
    run(1)
    check(picked == [made, pale, .blue] && palette.draft == nil && palette.cardOpenness < 0.01 && slot.tint == pale,
          "choosing one of Lasso's colours while the card is open puts the card away and chooses it")
    palette.plusButton.performClick(nil)
    run(1)
    palette.card.doneButton.performClick(nil)
    run(1)
    check(picked.last == .blue && palette.selected == .blue && palette.slotColor == pale,
          "a colour made that is one of Lasso's own is chosen as that colour")
    let offered = DirectoryColorPaletteRow(selected: .teal, custom: made) { _ in }
    check(!offered.swatches[offered.slotIndex].isHidden && offered.swatches[offered.slotIndex].tint == made,
          "the last colour made is offered in other folders' pickers")
}

print("a chosen colour keeps stretching while the panel rebuilds its rows")
do {
    _ = NSApplication.shared
    var now = 120.0
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 80), styleMask: [.borderless],
                          backing: .buffered, defer: true)
    let palette = DirectoryColorPaletteRow(selected: .blue) { _ in }
    palette.frame = NSRect(x: 0, y: 0, width: 280, height: 32)
    palette.drivesItself = false
    palette.animatesOffscreen = true
    palette.reducesMotion = { false }
    palette.clock = { now }
    window.contentView?.addSubview(palette)
    func run(_ seconds: Double) {
        let end = now + seconds
        while now < end - 1e-9 {
            now += 1.0 / 120
            palette.tick()
        }
    }
    palette.open()
    run(1)
    palette.swatches[3].performClick(nil)
    run(0.04)
    let midway = palette.shownWidths[3]
    // Choosing saves the colour, and the panel takes its rows out and puts them back.
    palette.animatesOffscreen = false
    palette.removeFromSuperview()
    palette.update(selected: .orange, isEnabled: true)
    check(palette.shownWidths[3] == midway && midway < palette.targetWidths[3],
          "out of the panel for a moment, the stretch waits where it was instead of jumping to the pill")
    palette.animatesOffscreen = true
    window.contentView?.addSubview(palette)
    check(palette.shownWidths[3] == midway, "put back, it carries on from there")
    run(1)
    check(palette.shownWidths[3] == palette.targetWidths[3] && palette.letterOpacities(.orange).allSatisfy { $0 == 1 },
          "and arrives at the pill with its name")
    palette.removeFromSuperview()
}

print("the bar fills with blocks that spread as it moves and close up at rest")
do {
    _ = NSApplication.shared
    let solid = DirectoryProgressBar.solid, dark = DirectoryProgressBar.dark
    let light = DirectoryProgressBar.light, track = DirectoryProgressBar.track
    let bar = DirectoryProgressBar(frame: NSRect(x: 0, y: 0, width: 210, height: 9))
    let count = bar.cellCount
    check(count >= 30, "the track holds enough cells to move in small steps (\(count))")
    let solids = { bar.glyphs.filter { $0 == solid }.count }
    bar.value = 50
    check(solids() == Int(Double(count) * 0.5) && !bar.glyphs.contains(dark) && !bar.glyphs.contains(light),
          "at rest the bar is solid up to its value, with no shades")
    bar.value = 99
    check(bar.glyphs.last == track, "99% never looks done")
    bar.value = 100
    check(bar.glyphs.allSatisfy { $0 == solid }, "100% fills the bar")
    check(String(DirectoryProgressBar.cells(count: 24, lead: 20, followers: [17.5, 15.2], fills: true))
          == "\(String(repeating: solid, count: 15))\(light)\(track)\(dark)\(track)\(solid)\(String(repeating: track, count: 4))",
          "a moving bar trails a dark and a light shade behind its solid block, spread apart")

    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 240, height: 40), styleMask: [.borderless],
                          backing: .buffered, defer: true)
    let moving = DirectoryProgressBar(frame: NSRect(x: 0, y: 0, width: 210, height: 9))
    window.contentView?.addSubview(moving)
    if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
        moving.value = 10
        for _ in 0..<120 { moving.advance(by: 1.0 / 60) }
        moving.value = 80
        moving.advance(by: 1.0 / 60)
        check(moving.glyphs.contains(dark) || moving.glyphs.contains(light),
              "a jump spreads the shades out behind the leading block")
        for _ in 0..<120 { moving.advance(by: 1.0 / 60) }
        check(!moving.glyphs.contains(dark) && !moving.glyphs.contains(light) && !moving.isAnimating,
              "and they close up behind it once it rests")
    }
    check(moving.glyphs.filter { $0 == solid }.count == Int(Double(moving.cellCount) * 0.8),
          "the settled bar shows the value it was given")

    let sweeping = DirectoryProgressBar(frame: NSRect(x: 0, y: 0, width: 210, height: 9))
    sweeping.indeterminate = true
    sweeping.advance(by: 0.5)
    let first = sweeping.glyphs.firstIndex(of: solid)
    sweeping.advance(by: 0.5)
    let second = sweeping.glyphs.firstIndex(of: solid)
    check(sweeping.glyphs.filter { $0 == solid }.count == 1 && first != nil && second != nil && first != second,
          "with no percentage, one solid block sweeps the track")
    check(sweeping.glyphs.contains(dark) || sweeping.glyphs.contains(light),
          "with its shades trailing it")
    moving.removeFromSuperview()
}

print("spreadsheet previews in the suggestion card read like the sheet")
do {
    func row(_ number: Int, _ values: [String], cited: Int? = nil) -> AssistPreviewRow {
        AssistPreviewRow(rowNumber: number, cells: values.enumerated().map {
            AssistPreviewCell(value: $0.element, cited: $0.offset == cited)
        })
    }
    // Six points per character keeps the expectations independent of fonts.
    let measure: (String, NSFont) -> CGFloat = { text, _ in CGFloat(text.count) * 6 }
    let size = CGSize(width: 358, height: 233)
    let headers = ["Account", "Actual", "Budget", "Actual - budget", "Variance %", "Department"]
    let note = "Positive expense variance = over budget. Blue values = inputs. Green = worksheet links."
    let rows = [
        row(19, ["Total operating expenses", "$129,950", "$129,900", "$50", "0.04%", "Finance"]),
        row(20, ["Operating income", "$63,050", "$75,100", "($12,050)", "(16.0%)", "Finance"]),
        row(24, ["Sources and assumptions", "", "", "", "", ""]),
        row(25, ["Fictional test data generated for Lasso.", "", "", "", "", ""]),
        row(27, [note, "", "", "", "", ""], cited: 0),
    ]
    let layout = AssistTableLayout(headers: headers, rows: rows, size: size, measure: measure)
    check(layout.rowRange == 0..<5, "the table above a cited footnote is shown, not only the notes")
    check(layout.visibleColumns == [0, 1, 2, 3], "as many columns are shown as fit at a readable width")
    check(abs(layout.columnWidths.reduce(0, +) - (size.width - AssistTableLayout.rowHeaderWidth)) < 0.5,
          "the columns fill the table")
    check(layout.columnWidths[0] > layout.columnWidths[1], "the label column is wider than the number columns")
    let footnote = layout.cells(in: rows[4])
    check(footnote.count == 1 && footnote[0].span == layout.visibleColumns.count,
          "a note overflows across the empty cells to its right, as it does in the sheet")
    check(layout.rowHeights[4] > layout.rowHeight, "a cited note too long for one line wraps instead of being cut off")
    check(layout.rowHeights[0] == layout.rowHeight, "other rows keep one line")
    let numbers = layout.cells(in: rows[1])
    check(numbers.count == 4 && numbers[0].alignment == .left && numbers[1].alignment == .right
          && numbers[3].alignment == .right, "labels align left and numbers align right")
    check(layout.numericColumns == [1, 2, 3], "number columns are recognised, including ($12,050)")
    check(AssistTableLayout.isNumeric("1.23E+04") && AssistTableLayout.isNumeric("-")
          && !AssistTableLayout.isNumeric("E12") && !AssistTableLayout.isNumeric("Room E2"),
          "scientific numbers align right but codes such as E12 stay text")
    check(AssistTableLayout.letterFont.pointSize >= 10, "column letters meet the 10 point text minimum")
    check(!layout.startsAfterGap(rows, at: 1) && layout.startsAfterGap(rows, at: 2),
          "skipped empty rows between 20 and 24 are marked")
    let mixed = layout.cells(in: row(30, ["Rent", "", "$18,000", "", "", ""]))
    check(mixed.map(\.span) == [1, 1, 1, 1], "a short label does not claim its empty neighbours")

    // The way into a lone cited cell: its row from the number up to it, its column from the letter down to it.
    let ledger = [row(4, ["North Ridge", "35000", "Due"]), row(5, ["Cedar Packaging", "17250", "Due"], cited: 1),
                  row(6, ["Pine Facilities", "32500", "Due"])]
    let both = TableCitationMarks(rows: ledger, visibleColumns: [0, 1, 2])
    check(both.cell?.row == 1 && both.cell?.column == 1, "a lone cited cell is found among the shown columns")
    check(both.markedRows == [1] && both.markedColumns == [1], "its row number and column letter are both marked")
    let hidden = TableCitationMarks(rows: ledger, visibleColumns: [0, 2])
    check(hidden.cell == nil && hidden.markedColumns.isEmpty, "a cited cell in a column not shown leads nowhere")
    let wholeColumn = [row(1, ["Supplier", "Outstanding"], cited: 1), row(2, ["Maple", "22000"], cited: 1)]
    let several = TableCitationMarks(rows: wholeColumn, visibleColumns: [0, 1])
    check(several.cell == nil && several.markedRows == [0, 1] && several.markedColumns == [1],
          "a whole column cited has no single way in, so only its headers are marked")

    let wideHeaders = (0..<10).map { "H\($0)" }
    let wide = AssistTableLayout(headers: wideHeaders, rows: [row(5, (0..<10).map { "\($0 * 1000)" }, cited: 8)],
                                 size: size, measure: measure)
    check(wide.visibleColumns.first == 0 && wide.visibleColumns.contains(8),
          "a cited cell far to the right is shown beside the label column")
    check(wide.visibleColumns == wide.visibleColumns.sorted(), "columns stay in sheet order")

    let short = AssistTableLayout(headers: ["Item", "Cost"], rows: [row(2, ["Rent", "18,000"])],
                                  size: size, measure: measure)
    let long = AssistTableLayout(headers: ["Item", "Actual amount recorded for the current reporting period"],
                                 rows: [row(2, ["Rent", "18,000"])], size: size, measure: measure)
    check(short.headerHeight < long.headerHeight, "the header grows only when headings wrap")

    let tall = (1...20).map { row($0, ["Line \($0)", "\($0)"], cited: $0 == 20 ? 0 : nil) }
    let tallLayout = AssistTableLayout(headers: ["Item", "Value"], rows: tall, size: size, measure: measure)
    check(tallLayout.rowRange.upperBound == 20 && tallLayout.rowRange.count > 3,
          "a cited last row is shown with as many rows above it as fit")
    let used = tallLayout.headerHeight + tallLayout.rowHeights.reduce(0, +)
    check(used <= size.height && used + tallLayout.rowHeight > size.height, "rows fill the available height")
    check(tallLayout.rowsBelow == 0, "a cited cell's context does not count rows below it")

    // A column name's preview lists its whole column, heading row first.
    let column = (1...12).map { row($0, ["Supplier \($0)", "2026-09-\(10 + $0)"], cited: $0 == 1 ? 1 : nil) }
    let columnHeaders = ["Supplier", "Invoice Date"]
    let listed = AssistTableLayout(headers: columnHeaders, rows: column, size: size,
                                   listing: .init(), measure: measure)
    check(listed.rowRange.lowerBound == 0 && listed.rowRange.count > 3 && listed.rowRange.upperBound < column.count,
          "a column too long for the card starts at its first row")
    check(listed.rowsBelow == column.count - listed.rowRange.upperBound, "the rows below the ones shown are counted")
    let listedHeight = listed.headerHeight + listed.rowHeights.reduce(0, +) + AssistTableLayout.moreRowsHeight
    check(listedHeight <= size.height, "the count of rows below fits under the rows shown")
    check(listed.lastFirstRow > 0, "a column too long for the card scrolls")
    let scrolled = AssistTableLayout(headers: columnHeaders, rows: column, size: size,
                                     listing: .init(firstRow: 2), measure: measure)
    check(scrolled.rowRange.lowerBound == 2 && scrolled.visibleColumns == listed.visibleColumns
          && scrolled.columnWidths == listed.columnWidths, "scrolling moves the rows and keeps the columns still")
    let bottom = AssistTableLayout(headers: columnHeaders, rows: column, size: size,
                                   listing: .init(firstRow: 100), measure: measure)
    check(bottom.rowRange.upperBound == column.count && bottom.rowRange.lowerBound == listed.lastFirstRow
          && bottom.rowsBelow == 0, "scrolling stops once the last row is shown")
    check(bottom.headerHeight + bottom.rowHeights.reduce(0, +) <= size.height, "the last rows fit without a count")
    let few = Array(column.prefix(4))
    let whole = AssistTableLayout(headers: columnHeaders, rows: few, size: size, listing: .init(), measure: measure)
    check(whole.rowRange == 0..<4 && whole.rowsBelow == 0 && whole.lastFirstRow == 0,
          "a short column shows every row with nothing to scroll")
    let unsent = AssistTableLayout(headers: columnHeaders, rows: few, size: size,
                                   listing: .init(moreRows: 40), measure: measure)
    check(unsent.rowRange == 0..<4 && unsent.rowsBelow == 40 && unsent.lastFirstRow == 0,
          "rows of the column the server left out are counted too")

    // A column name suggested comes with its header row among the rows; the card shows its names once, in the header.
    func preview(_ headers: [String], _ rows: [AssistPreviewRow], headerRows: [Int]) -> AssistDocumentPreview {
        var result = AssistDocumentPreview(filename: "Payables.csv", path: "/Payables.csv", location: "", context: "",
                                           valueText: nil, objectType: "VARIABLE", snapshotVersion: nil,
                                           columns: headers.indices.map { String(UnicodeScalar(65 + $0)!) },
                                           headers: headers, rows: rows)
        result.headerRowNumbers = headerRows
        return result
    }
    let named = preview(["Supplier", "Invoice"], [row(1, ["Supplier", "Invoice"], cited: 0),
                                                   row(2, ["Maple", "BILL-1160"]), row(3, ["Harbour", "BILL-1174"])],
                        headerRows: [1]).foldingHeaderRow()
    check(named.rows.map(\.rowNumber) == [2, 3], "the header row is not repeated under the column names")
    check(named.citedHeadings == [0], "the cited column name is marked in the header instead")
    let unlisted = preview(["Supplier", "Invoice"], [row(1, ["Supplier", "Invoice"]), row(2, ["Maple", "BILL-1160"])],
                           headerRows: []).foldingHeaderRow()
    check(unlisted.rows.map(\.rowNumber) == [2] && unlisted.citedHeadings.isEmpty,
          "a row that repeats the column names is folded even when the server does not say it is the header")
    let values = preview(["Supplier", "Invoice"], [row(2, ["Maple", "BILL-1160"], cited: 1)], headerRows: [1])
        .foldingHeaderRow()
    check(values.rows.count == 1 && values.citedHeadings.isEmpty, "rows below the header are left as they are")
    let lone = preview(["Supplier"], [row(1, ["Supplier"], cited: 0)], headerRows: [1]).foldingHeaderRow()
    check(lone.rows.count == 1, "a header row with nothing below it stays, so the table still shows")
}

print("directory colors follow accepted source references")
do {
    let defaults = MemoryDirectoryDefaults(suiteName: nil)!
    check(DirectoryColorPreferences.color(for: "finance", defaults: defaults) == .blue,
          "an uncustomized directory matches the menu's default blue")
    check(DirectoryColorPreferences.color(for: nil, defaults: defaults) == nil,
          "an unresolved legacy owner retains its file-color fallback")
    DirectoryColorPreferences.set(.orange, for: "finance", defaults: defaults)
    DirectoryColorPreferences.set(.green, for: "research", defaults: defaults)

    func reference(_ id: String, owner: String, path: String, slot: Int) -> DependencyReference {
        var result = DependencyReference(
            id: id, objectId: "object-" + id, versionId: "v1",
            hostBundleIdentifier: "com.google.Chrome", hostApplication: "Google Chrome",
            documentContext: "draft", anchor: anchor(for: "120", in: "Supplies were 120."),
            state: .healthy, label: "Supplies", valueText: "120",
            sourcePath: path, sourceLocation: "B2", sourceColorSlot: slot,
            createdAt: Date(), updatedAt: Date())
        result.projectId = owner
        return result
    }
    func matches(_ left: NSColor, _ right: NSColor) -> Bool {
        let a = left.usingColorSpace(.sRGB)!, b = right.usingColorSpace(.sRGB)!
        return abs(a.redComponent - b.redComponent) < 0.00001
            && abs(a.greenComponent - b.greenComponent) < 0.00001
            && abs(a.blueComponent - b.blueComponent) < 0.00001
    }
    func stroke(_ reference: DependencyReference) -> NSColor {
        DependencyStyle.stroke(for: reference.state, sourceSlot: reference.sourceColorSlot ?? 0,
            directoryColor: DirectoryColorPreferences.color(for: reference.projectId, defaults: defaults), hovered: true)
    }
    let first = reference("first", owner: "finance", path: "Budget.xlsx", slot: 1)
    let second = reference("second", owner: "finance", path: "Expenses.csv", slot: 6)
    let duplicate = reference("duplicate", owner: "research", path: "Budget.xlsx", slot: 1)
    check(matches(stroke(first), DirectoryToggleColor.orange.color)
          && matches(stroke(second), DirectoryToggleColor.orange.color),
          "different files inside a directory use its selected color")
    check(matches(stroke(duplicate), DirectoryToggleColor.green.color),
          "identical file paths in different directories keep their owner's color")
    DirectoryColorPreferences.set(.orange, for: "research", defaults: defaults)
    check(matches(stroke(first), stroke(duplicate)),
          "intentionally matching directory colors are not reassigned")
    DirectoryColorPreferences.set(.purple, for: "finance", defaults: defaults)
    check(matches(stroke(first), DirectoryToggleColor.purple.color)
          && matches(stroke(second), DirectoryToggleColor.purple.color),
          "changing a directory recolors references already accepted with Tab")
    let reloaded = MemoryDirectoryDefaults(suiteName: nil)!
    reloaded.values = defaults.values
    check(DirectoryColorPreferences.color(for: first.projectId, defaults: reloaded) == .purple,
          "saved directory choices are read consistently after preferences reload")
    check(matches(
        DependencyStyle.stroke(for: .stale, sourceSlot: 1, directoryColor: .orange, hovered: true),
        DependencyStyle.stroke(for: .stale, sourceSlot: 1, directoryColor: .green, hovered: true)),
          "source warning states keep their distinct styling")
}

print("source-backed model previews")
do {
    let bounds: [String: Any] = ["minX": 10.0, "minY": 20.0, "maxX": 20.0, "maxY": 30.0]
    let modelJSON: [String: Any] = [
        "kind": "model-plan", "bounds": bounds, "focusBounds": bounds,
        "selected": ["id": 42, "guid": "wall-guid", "label": "Exterior Wall", "entityType": "IFCWALLSTANDARDCASE"],
        "storey": ["label": "Level 1"], "warnings": [],
        "elements": [[
            "id": 42, "guid": "wall-guid", "label": "Exterior Wall", "entityType": "IFCWALLSTANDARDCASE",
            "role": "context", "selected": true,
            "polygons": [
                [[10.0, 20.0], [20.0, 20.0], [20.0, 30.0], [10.0, 30.0]],
                [[12.0, 22.0], [18.0, 22.0], [18.0, 28.0], [12.0, 28.0]],
            ],
        ]],
    ]
    let response: [String: Any] = [
        "source": ["filename": "Building.ifc", "location": "Exterior Wall", "objectType": "DRAWING_ANNOTATION"],
        "path": "Architecture/Building.ifc", "preview": modelJSON,
    ]
    let data = try! JSONSerialization.data(withJSONObject: response)
    let parsed = AssistDocumentPreview.parse(data)!
    let model = parsed.model!
    check(model.selectedEntityType == "IFCWALLSTANDARDCASE" && model.elements[0].selected,
          "selects non-room IFC products by source identity")
    check(model.elements[0].guid == "wall-guid" && model.elements[0].polygons.count == 2,
          "preserves selected geometry and opening rings from the source response")
    check(parsed.path == "Architecture/Building.ifc" && parsed.rows.isEmpty,
          "routes an IFC preview to model rendering instead of an empty table")

    let transform = AssistModelTransform(bounds: model.focusBounds,
        viewport: NSRect(x: 5, y: 7, width: 220, height: 120))!
    check(transform.scale == 10, "fits focused geometry without changing its aspect ratio")
    check(transform.point(NSPoint(x: 10, y: 30)) == NSPoint(x: 65, y: 17) &&
          transform.point(NSPoint(x: 20, y: 20)) == NSPoint(x: 165, y: 117),
          "keeps IFC plan orientation when mapping into a flipped native view")
    let path = transform.path(for: model.elements[0])
    check(path.contains(transform.point(NSPoint(x: 11, y: 21))) &&
          !path.contains(transform.point(NSPoint(x: 15, y: 25))),
          "renders real wall geometry while leaving its opening unfilled")
    check(AssistModelTransform(bounds: model.bounds, viewport: .zero) == nil,
          "rejects an empty drawing viewport")
    check(AssistModelBounds(json: ["minX": 0, "minY": 0, "maxX": 0, "maxY": 2]) == nil &&
          AssistModelBounds(json: ["minX": 0, "minY": 0, "maxX": Double.infinity, "maxY": 2]) == nil,
          "rejects degenerate and non-finite geometry bounds")
    var invalid = modelJSON
    invalid["elements"] = [["polygons": [[[Double.nan, 1], [2, 3], [4, 5]]]]]
    check(AssistModelPreview(json: invalid) == nil,
          "does not draw fabricated replacement geometry for malformed coordinates")

    let wireframe: [String: Any] = [
        "kind": "model-plan", "view": "Isometric view", "bounds": bounds, "focusBounds": bounds,
        "selected": ["guid": "Bracket", "label": "Bracket · Ø8 hole", "entityType": "Ø8 hole"], "warnings": [],
        "elements": [[
            "guid": "Bracket", "role": "context", "selected": true, "polygons": [] as [Any],
            "lines": [[[10.0, 20.0], [20.0, 30.0]], [[Double.nan, 1.0], [2.0, 3.0]]],
        ]],
    ]
    let cad = AssistModelPreview(json: wireframe)!
    check(cad.viewLabel == "Isometric view" && cad.elements[0].lines.count == 1 && cad.elements[0].polygons.isEmpty,
          "keeps finite STEP wireframe edges and the server's view label")
    check(transform.path(for: cad.elements[0]).isEmpty && transform.linePath(for: cad.elements[0]).elementCount == 2,
          "strokes open CAD edges without inventing a filled outline")

    let doorArc: [String: Any] = [
        "id": "20/A", "type": "path", "layer": "DOORS", "elevation": 0,
        "points": [[10.0, 20.0], [17.0710678, 22.9289322], [20.0, 30.0]],
        "closed": false, "lineweight": 25,
    ]
    let roomText: [String: Any] = [
        "id": "21", "type": "text", "layer": "ROOM-LABELS", "elevation": 0,
        "point": [15.0, 25.0], "text": "STUDIO\n12 m²", "height": 0.5,
        "rotation": 450.0, "align": "middle", "verticalAlign": "middle", "widthScale": 1.5,
    ]
    var drawingJSON = modelJSON
    drawingJSON["elements"] = []
    drawingJSON["selected"] = [:]
    drawingJSON["drawing"] = [doorArc, roomText]
    let drawingModel = AssistModelPreview(json: drawingJSON)!
    check(drawingModel.elements.isEmpty && drawingModel.drawing.count == 2,
          "opens a line-and-text DXF drawing without inventing a measurable room")
    if case .path(let drawing) = drawingModel.drawing[0] {
        let path = transform.path(for: drawing)
        check(drawing.id == "20/A" && drawing.layer == "DOORS" && drawing.lineweight == 25 &&
              drawing.points[1] == NSPoint(x: 17.0710678, y: 22.9289322),
              "keeps source block identity, pen weight and supplied curved path vertices")
        check(path.elementCount == 3 && path.element(at: 2) == .lineTo &&
              path.currentPoint == NSPoint(x: 165, y: 17),
              "projects tessellated curves with the same source scale and leaves door arcs open")
    } else { check(false, "parses a DXF drafting path") }
    if case .text(let drawing) = drawingModel.drawing[1] {
        check(drawing.text == "STUDIO\n12 m²" && drawing.height == 0.5 && drawing.rotation == 90 &&
              drawing.align == "middle" && drawing.verticalAlign == "middle" && drawing.widthScale == 1.5,
              "preserves source text, source size, alignment, width factor and rotation")
        let textTransform = transform.textTransform(for: drawing)
        let anchor = transform.point(drawing.point)
        let origin = textTransform.transform(NSPoint.zero)
        let alongText = textTransform.transform(NSPoint(x: 1, y: 0))
        let downGlyph = textTransform.transform(NSPoint(x: 0, y: 1))
        check(origin == anchor && abs(alongText.x - anchor.x) < 0.00001 &&
              abs(alongText.y - (anchor.y - 1.5)) < 0.00001 &&
              abs(downGlyph.x - (anchor.x + 1)) < 0.00001 && abs(downGlyph.y - anchor.y) < 0.00001,
              "rotates DXF text counterclockwise in source space without mirroring its glyphs")
    } else { check(false, "parses DXF source annotation text") }
    var closedBoundary = doorArc
    closedBoundary["closed"] = true
    var budget = 3
    if case .path(let drawing)? = AssistModelDrawing.parse(closedBoundary, remainingPoints: &budget) {
        check(transform.path(for: drawing).element(at: 3) == .closePath && budget == 0,
              "closes only source paths explicitly marked closed and accounts for their point budget")
    } else { check(false, "parses an explicitly closed source path") }
    budget = 2
    check(AssistModelDrawing.parse(doorArc, remainingPoints: &budget) == nil && budget == 2,
          "rejects over-budget paths as a whole instead of fabricating a truncated outline")
    var badDrawingItems: [[String: Any]] = []
    for (key, value) in [("points", [[Double.nan, 20], [20, 30]] as Any),
                         ("points", [[true, false], [false, true]] as Any),
                         ("points", [[1e13, 20], [20, 30]] as Any),
                         ("elevation", Double.infinity as Any),
                         ("lineweight", -1 as Any)] {
        var malformed = doorArc
        malformed[key] = value
        badDrawingItems.append(malformed)
    }
    for (key, value) in [("height", 0 as Any), ("rotation", Double.nan as Any),
                         ("widthScale", -1 as Any), ("align", "unknown" as Any),
                         ("verticalAlign", "unknown" as Any), ("text", String(repeating: "A", count: 16_385) as Any)] {
        var malformed = roomText
        malformed[key] = value
        badDrawingItems.append(malformed)
    }
    drawingJSON["drawing"] = badDrawingItems
    check(AssistModelPreview(json: drawingJSON) == nil,
          "rejects non-finite, Boolean, oversized and malformed drawing values without replacement geometry")
    drawingJSON["drawing"] = badDrawingItems + [doorArc]
    check(AssistModelPreview(json: drawingJSON)?.drawing.count == 1,
          "keeps valid source drafting when an unrelated malformed item is rejected")
    var combinedJSON = modelJSON
    combinedJSON["drawing"] = [doorArc, roomText]
    let combinedModel = AssistModelPreview(json: combinedJSON)!
    check(combinedModel.elements[0].polygons == model.elements[0].polygons &&
          combinedModel.elements[0].selected && combinedModel.drawing.count == 2,
          "keeps authoritative selected regions separate from decorative lines and text")

    var unavailable = response
    unavailable["preview"] = ["kind": "model-unavailable", "reason": "This element has properties but no geometric representation."]
    let unavailablePreview = AssistDocumentPreview.parse(try! JSONSerialization.data(withJSONObject: unavailable))!
    check(unavailablePreview.model == nil && unavailablePreview.unavailableReason?.contains("no geometric representation") == true,
          "explains why an indexed element cannot be drawn")

    var table = response
    table["preview"] = ["columns": ["B"], "headers": ["Area"], "rows": [["rowNumber": 7, "cells": [["value": "42", "cited": true]]]]]
    let tablePreview = AssistDocumentPreview.parse(try! JSONSerialization.data(withJSONObject: table))!
    check(tablePreview.model == nil && tablePreview.rows[0].cells[0].cited && tablePreview.rows[0].rowNumber == 7,
          "preserves exact-cell spreadsheet preview parsing")
    check(model.orbit == nil, "keeps IFC plans flat")
}

print("rotating and zooming 3D model previews")
do {
    func near(_ a: NSPoint, _ b: NSPoint, _ tolerance: CGFloat = 1e-6) -> Bool {
        abs(a.x - b.x) < tolerance && abs(a.y - b.y) < tolerance
    }
    func nearLines(_ a: [[NSPoint]], _ b: [[NSPoint]]) -> Bool {
        a.count == b.count && zip(a, b).allSatisfy { $0.count == $1.count && zip($0, $1).allSatisfy { near($0, $1) } }
    }
    let root2 = 2.0.squareRoot(), root3 = 3.0.squareRoot(), root6 = 6.0.squareRoot()
    // A block's X and Z edges and a cited vertical Ø4 bore, projected
    // isometrically by the server, with the 3D source of every line.
    let block: [String: Any] = [
        "guid": "Block", "role": "context", "selected": false, "polygons": [] as [Any],
        "lines": [[[0.0, 0.0], [-10 / root2, -10 / root6]], [[0.0, 0.0], [0.0, 20 / root6]]],
        "edges": [[[0.0, 0.0, 0.0], [10.0, 0.0, 0.0]], [[0.0, 0.0, 0.0], [0.0, 0.0, 10.0]]],
        "cylinders": [] as [Any],
    ]
    let bore: [String: Any] = [
        "guid": "Block", "role": "context", "selected": true, "polygons": [] as [Any],
        "lines": [[[2.0, -10 / root6], [2.0, 10 / root6]], [[-2.0, -10 / root6], [-2.0, 10 / root6]]],
        "edges": [] as [Any],
        "cylinders": [["center": [5.0, 5.0, 0.0], "axis": [0.0, 0.0, 1.0], "xdir": [1.0, 0.0, 0.0],
                       "ydir": [0.0, 1.0, 0.0], "radius": 2.0, "h0": 0.0, "h1": 10.0]],
    ]
    let solidJSON: [String: Any] = [
        "kind": "model-plan", "view": "Isometric view", "warnings": [] as [Any],
        "bounds": ["minX": -8.0, "minY": -5.0, "maxX": 3.0, "maxY": 9.0],
        "focusBounds": ["minX": -3.0, "minY": -5.0, "maxX": 3.0, "maxY": 5.0],
        "selected": ["guid": "Block", "label": "Block · Ø4 hole", "entityType": "Ø4 hole"],
        "orbit": ["azimuth": Double.pi / 4, "elevation": atan(0.5.squareRoot()), "pivot": [5.0, 5.0, 5.0]],
        "elements": [block, bore],
    ]
    let iso = AssistModelCamera.isometric.axes
    check(abs(iso.toward.x - 1 / root3) < 1e-12 && abs(iso.toward.z - 1 / root3) < 1e-12 &&
          abs(iso.right.x + 1 / root2) < 1e-12 && abs(iso.up.z - 2 / root6) < 1e-12,
          "the default camera is the server's isometric view")
    let solid = AssistModelPreview(json: solidJSON)!
    check(solid.orbit?.pivot == SIMD3(5, 5, 5) && solid.orbit?.camera == .isometric,
          "reads the camera and pivot a STEP preview was sent in")
    check(solid.elements.allSatisfy { nearLines($0.wire!.lines(iso), $0.lines) },
          "the default camera redraws exactly the lines the server sent, bore silhouettes included")

    let sent = solid.orbit!.camera
    let turned = AssistModelView().dragged(by: CGSize(width: 90, height: 0), from: sent)
    let azimuth = turned.camera!.azimuth
    check(min(azimuth, 2 * .pi - azimuth) < 1e-12 && turned.camera!.elevation == sent.elevation && turned.isTurned(from: sent),
          "dragging 90 points to the right turns the model a quarter of the way round")
    check(turned.dragged(by: .zero, from: sent) == turned &&
          AssistModelView().dragged(by: .zero, from: sent).isTurned(from: sent) == false,
          "a drag that ends where it started leaves the view as it was")
    let overTop = AssistModelView().dragged(by: CGSize(width: 0, height: 100_000), from: sent).camera!
    check(overTop.elevation < .pi / 2 && overTop.axes.up.z > 0,
          "tilting stops short of the top view instead of flipping the model over")

    let rect = NSRect(x: 20, y: 30, width: 344, height: 222)
    let viewport = AssistModelRenderer.viewport(in: rect)
    let fitted = AssistModelTransform(bounds: solid.focusBounds, viewport: viewport)!
    let flat = AssistModelRenderer.layout(solid, viewport: viewport, view: AssistModelView())!
    check(flat.elements[0].lines == solid.elements[0].lines && flat.transform.scale == fitted.scale &&
          flat.transform.point(NSPoint(x: 1, y: 2)) == fitted.point(NSPoint(x: 1, y: 2)),
          "an untouched preview draws as before")
    let rotated = AssistModelRenderer.layout(solid, viewport: viewport, view: turned)!
    check(!nearLines(rotated.elements[1].lines, solid.elements[1].lines) &&
          near(rotated.transform.point(turned.camera!.axes.project(SIMD3(5, 5, 5))),
               NSPoint(x: viewport.midX, y: viewport.midY)),
          "a turned view redraws from 3D and orbits around the cited feature")

    let range = AssistModelRenderer.zoomRange(for: solid, in: rect)
    check(range.contains(1) && abs(range.upperBound - 10) < 1e-9 && range.lowerBound < 1,
          "zoom reaches a tenth of the selection and twice the whole model")
    let closest = AssistModelView().zoomed(by: 1_000, within: range)
    let farthest = AssistModelView().zoomed(by: 0.000_1, within: range)
    check(closest.zoom == range.upperBound && farthest.zoom == range.lowerBound,
          "zoom stops at its limits")
    let zoomed = AssistModelRenderer.layout(solid, viewport: viewport, view: closest)!
    check(abs(zoomed.transform.scale - fitted.scale * closest.zoom) < 1e-9 && zoomed.elements[0].lines == solid.elements[0].lines,
          "zooming scales the sent drawing about the selection")
    check(AssistModelRenderer.caption(for: solid, view: AssistModelView()) == "Isometric view · Drag to rotate, scroll to zoom" &&
          AssistModelRenderer.caption(for: solid, view: turned) == "Rotated view · Double-click to reset" &&
          AssistModelRenderer.caption(for: solid, view: nil) == "Isometric view",
          "the caption says how to turn the model and how to get back")

    var partial = solidJSON
    partial["elements"] = [block, bore.filter { $0.key != "edges" }]
    let flatOnly = AssistModelPreview(json: partial)
    check(flatOnly != nil && flatOnly?.orbit == nil,
          "a preview missing any element's 3D source still draws, but does not rotate")
    var badPivot = solidJSON
    badPivot["orbit"] = ["azimuth": 0.0, "elevation": 0.0, "pivot": [0.0, Double.nan, 0.0]]
    check(AssistModelPreview(json: badPivot)?.orbit == nil, "rejects a non-finite orbit pivot")
}

print("Markdown and text previews")
do {
    let payload: [String: Any] = [
        "source": ["filename": "README.md", "location": "—", "context": "—", "objectType": "DOCUMENT"],
        "path": "README.md",
        "preview": ["kind": "text", "format": "markdown", "location": "Try Lasso · Line 8",
                    "text": "Toggle the other folder off.",
                    "blocks": [["type": "heading", "level": 2, "text": "Try Lasso"],
                               ["type": "item", "level": 0, "marker": "2.", "text": "Toggle the **other** folder off.", "cited": true]]],
    ]
    let parsed = AssistDocumentPreview.parse(try! JSONSerialization.data(withJSONObject: payload))!
    check(parsed.isMarkdown && parsed.textBlocks.count == 2 && parsed.textBlocks[1].cited
          && parsed.textBlocks[1].marker == "2." && parsed.location == "Try Lasso · Line 8",
          "parses Markdown blocks, the cited item and its section location")
    var placeholder = payload
    placeholder["preview"] = NSNull()
    let empty = AssistDocumentPreview.parse(try! JSONSerialization.data(withJSONObject: placeholder))!
    check(empty.location.isEmpty && empty.context.isEmpty,
          "never shows the server's em dash placeholder as a location or excerpt")
    let item = AssistMarkdown.attributed(parsed.textBlocks[1], baseSize: 11)
    check(item.string == "2.\tToggle the other folder off.", "renders list markers without Markdown syntax")
    let bold = (item.string as NSString).range(of: "other")
    let font = item.attribute(.font, at: bold.location, effectiveRange: nil) as? NSFont
    check(font?.fontDescriptor.symbolicTraits.contains(.bold) == true, "renders strong emphasis in bold")
    let heading = AssistMarkdown.attributed(parsed.textBlocks[0], baseSize: 11)
    check(heading.string == "Try Lasso" && ((heading.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize ?? 0) > 11,
          "renders headings larger than body text, without hash marks")
    var lines = payload
    lines["preview"] = ["kind": "text", "format": "plain",
                        "lines": [["value": "alpha", "lineNumber": 4], ["value": "beta", "lineNumber": 5, "cited": true]]]
    let plain = AssistDocumentPreview.parse(try! JSONSerialization.data(withJSONObject: lines))!
    check(!plain.isMarkdown && plain.textBlocks.map(\.type) == ["line", "line"] && plain.textBlocks[1].cited
          && plain.textBlocks[1].lineNumber == 5, "keeps plain text sources as cited lines")
}

print("PDF page previews")
do {
    let payload: [String: Any] = [
        "source": ["filename": "drawing.pdf", "location": "Page 2", "objectType": "DRAWING"],
        "path": "drawing.pdf",
        "preview": ["kind": "pdf", "page": 2,
                    "fileUrl": "/api/dependency-objects/drawing/source?version=pinned",
                    "selectedText": "Source text"],
    ]
    let parsed = AssistDocumentPreview.parse(try! JSONSerialization.data(withJSONObject: payload))!
    let pdf = parsed.pdf!
    let server = URL(string: "http://127.0.0.1:4319/")!
    check(pdf.pageNumber == 2 && pdf.selectedText == "Source text" && parsed.model == nil,
          "parses PDF page and excerpt identity without falling back to an empty document card")
    check(pdf.sourceURL(serverURL: server)?.absoluteString ==
          "http://127.0.0.1:4319/api/dependency-objects/drawing/source?version=pinned",
          "fetches PDF bytes from the pinned local source version")
    var incomplete = payload
    incomplete["preview"] = ["kind": "pdf", "page": 2]
    let unavailable = AssistDocumentPreview.parse(try! JSONSerialization.data(withJSONObject: incomplete))!
    check(unavailable.pdf == nil && unavailable.unavailableReason != nil,
          "missing PDF addresses remain retryable instead of caching an empty preview")
    for address in ["https://example.com/source.pdf", "http://127.0.0.1:4320/source.pdf", "file:///tmp/source.pdf"] {
        let outside = AssistPDFPreview(json: ["kind": "pdf", "fileUrl": address])!
        check(outside.sourceURL(serverURL: server) == nil, "rejects PDF preview URLs outside the local server")
    }
    check(AssistPDFPageImage.render(data: Data("invalid PDF".utf8), preview: pdf) == nil,
          "reports unreadable PDFs instead of caching a blank page")

    let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("test/fixtures/drawings/ncsu-office-kit.pdf")
    let data = try! Data(contentsOf: fixture)
    let document = PDFDocument(data: data)!
    let pageIndex = (0..<document.pageCount).first { !(document.page(at: $0)?.string ?? "").isEmpty }!
    let phrase = document.page(at: pageIndex)!.string!.components(separatedBy: .newlines)
        .first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }!
    let excerpt = AssistPDFPreview(json: ["kind": "pdf", "fileUrl": pdf.fileUrl,
                                        "pageNumber": pageIndex + 1, "selectedText": phrase])!
    let rendered = AssistPDFPageImage.render(data: data, preview: excerpt, size: NSSize(width: 720, height: 444))!
    check(rendered.pageNumber == pageIndex + 1 && rendered.highlighted && rendered.image.size.width > 0,
          "renders a real drawing PDF page and highlights its matched words")
    let lastPage = AssistPDFPreview(json: ["kind": "pdf", "fileUrl": pdf.fileUrl, "page": 9999])!
    check(AssistPDFPageImage.render(data: data, preview: lastPage)?.pageNumber == document.pageCount,
          "bounds invalid page numbers to an existing PDF page")

    let wrappedData = NSMutableData()
    var mediaBox = CGRect(x: 0, y: 0, width: 612, height: 792)
    let consumer = CGDataConsumer(data: wrappedData as CFMutableData)!
    let context = CGContext(consumer: consumer, mediaBox: &mediaBox, nil)!
    for lines in [["Opening page"], ["The preserved excerpt continues", "across wrapped lines on page two."]] {
        context.beginPDFPage(nil)
        for (index, value) in lines.enumerated() {
            context.textPosition = CGPoint(x: 50, y: 720 - index * 24)
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: value,
                attributes: [.font: NSFont.systemFont(ofSize: 12)]))
            CTLineDraw(line, context)
        }
        context.endPDFPage()
    }
    context.closePDF()
    let wrapped = AssistPDFPreview(json: ["kind": "pdf", "fileUrl": pdf.fileUrl, "page": 1,
        "selectedText": "The preserved excerpt continues across wrapped lines on page two."])!
    let wrappedPage = AssistPDFPageImage.render(data: wrappedData as Data, preview: wrapped)!
    check(wrappedPage.pageNumber == 2 && wrappedPage.highlighted,
          "finds and highlights normalized PDF excerpts across line wraps on later pages")
    let pageBox = CGRect(x: 0, y: 0, width: 612, height: 792)
    let line = CGRect(x: 50, y: 700, width: 180, height: 14)
    let focus = AssistPDFPageImage.focusRegion(around: line, page: pageBox, aspect: 1440.0 / 888.0)
    check(focus.map { $0.contains(line) && pageBox.contains($0) && $0.width < pageBox.width } == true,
          "a short cited passage is shown zoomed in, inside the page, so it can be read")
    let focusRatio: CGFloat = focus.map { $0.width / $0.height } ?? 0
    let previewRatio: CGFloat = 1440.0 / 888.0
    check(abs(focusRatio - previewRatio) < 0.01, "the zoomed area keeps the preview's proportions")
    check(AssistPDFPageImage.focusRegion(around: CGRect(x: 40, y: 40, width: 530, height: 700),
                                         page: pageBox, aspect: 1.6) == nil,
          "a citation covering most of the page shows the whole page")
    check(wrappedPage.focus != nil && wrappedPage.image.size.width > 0,
          "a rendered PDF excerpt is zoomed to its highlight")
    let wholePage = AssistPDFPageImage.render(data: wrappedData as Data,
        preview: AssistPDFPreview(json: ["kind": "pdf", "fileUrl": pdf.fileUrl, "page": 1])!)!
    check(wholePage.focus == nil && !wholePage.highlighted, "a page without a cited passage is shown whole")
}

print("Escape keeps the card away for its dismissed word")
var escapeQuiet = EscapeQuiet()
check(!escapeQuiet.holds(for: "Revenue was"), "nothing is held before Escape")
escapeQuiet.escaped(at: "Thanks for the notes. Can we move the mee")
check(escapeQuiet.holds(for: "Thanks for the notes. Can we move the meeting"), "finishing the dismissed word stays quiet")
check(escapeQuiet.holds(for: "Thanks for the notes. Can we move the meeting "), "a trailing space after the dismissed word stays quiet")
check(escapeQuiet.holds(for: "Thanks for the notes. Can we move the me"), "deleting within the dismissed word stays quiet")
check(!escapeQuiet.holds(for: "Thanks for the notes. Can we move the meeting to"), "starting the next word in the same sentence brings suggestions back")
check(!escapeQuiet.isHolding, "the hold ends once the next word starts")
escapeQuiet.escaped(at: "Thanks for the notes. Can we move the mee")
check(!escapeQuiet.holds(for: "Thanks for the notes. Can we move the "), "deleting the dismissed word completely brings suggestions back")
escapeQuiet.escaped(at: "Inv")
check(escapeQuiet.holds(for: "Invoice"), "finishing a leading dismissed word stays quiet")
check(!escapeQuiet.holds(for: ""), "emptying the field clears the Escape hold")
check(!escapeQuiet.holds(for: "Inv"), "retyping the word after emptying the field gets suggestions again")
escapeQuiet.escaped(at: "Office supplies ")
check(escapeQuiet.holds(for: "Office supplies "), "escaping after whitespace stays quiet at that spot")
check(!escapeQuiet.holds(for: "Office supplies rev"), "starting a new word after an escaped space brings suggestions back")
escapeQuiet.escaped(at: "Budget notes\nThe offi")
check(!escapeQuiet.holds(for: "Budget notes\nThe office\n"), "a new line brings suggestions back")
escapeQuiet.escaped(at: "First point. Second po")
check(!escapeQuiet.holds(for: "First poi"), "going back into earlier text ends the hold")
escapeQuiet.escaped(at: "Other field")
escapeQuiet.clear()
check(!escapeQuiet.holds(for: "Other field text"), "another field starts fresh")
escapeQuiet.escaped(at: "\\summarize the mee", throughSentence: true)
check(escapeQuiet.holds(for: "\\summarize the meeting to Friday"), "a dismissed writer prompt stays quiet through its sentence")
check(!escapeQuiet.holds(for: "\\summarize the meeting? Revenue"), "the next sentence clears a sentence-wide hold")
check(!escapeQuiet.holds(for: ""), "emptying the field clears a sentence-wide hold")

print("fields for finding things get no card")
check(HostTextSafety.isLookup(role: "AXTextField", subrole: "AXSearchField", identifier: nil), "a search field is not written in")
check(HostTextSafety.isLookup(role: "AXComboBox", subrole: nil, identifier: nil), "a combo box is a picker")
check(HostTextSafety.isLookup(role: "AXTextField", subrole: nil, identifier: "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD"), "a browser's address bar is a query")
check(!HostTextSafety.isLookup(role: "AXTextArea", subrole: nil, identifier: nil), "a text area is written in")
check(!HostTextSafety.isLookup(role: "AXTextField", subrole: nil, identifier: "subject"), "an ordinary text field is written in")

print("synthetic typing chunks")
let accented = String(repeating: "e\u{301}", count: 12) + "👩‍🔬 Café"
let accentedChunks = accented.chunkedForTyping(16)
check(accentedChunks.allSatisfy { $0.utf16.count <= 16 }, "every typing chunk fits the per-event UTF-16 limit")
check(accentedChunks.joined() == accented, "chunking keeps decomposed accents and emoji intact")
check(SyntheticKeyboard.canType("office supplies are up 4%") && SyntheticKeyboard.canType("BILL-1160")
      && SyntheticKeyboard.canType("$18,400.50"),
      "plain words, numbers and single hyphens are typed where the host ignores Accessibility writes")
check(["\n    allowed = [", "range(31)]\n", "a\r\nb", "one\u{2028}two"].allSatisfy { !SyntheticKeyboard.canType($0) },
      "text with a line break is pasted, never typed: typed line breaks arrived out of order in the Claude app")
check(["O'Brien", "\"quoted\"", "Q1 -- Q2", "etc...", "two  spaces"].allSatisfy { !SyntheticKeyboard.canType($0) },
      "quotes, double hyphens, ellipses and double spaces are pasted so AppKit substitutions cannot rewrite them")
check(accentedChunks.allSatisfy { $0.unicodeScalars.first?.properties.generalCategory != .nonspacingMark },
      "a chunk never begins with a detached combining accent")
check("Facilities".chunkedForTyping(16) == ["Facilities"], "short text is typed as one event")

print("node runtime discovery")
let bundledNode = "/Applications/Lasso.app/Contents/MacOS/node"
let nodeSearchOrder = nodeCandidates(override: "/custom/node", bundledNode: bundledNode,
                                     recordedNode: "/usr/local/bin/node", nvmRoot: "/nvm",
                                     nvmVersions: ["v9.11.2", "v24.1.0", "v22.3.0"])
check(Array(nodeSearchOrder.prefix(3)) == ["/custom/node", bundledNode, "/usr/local/bin/node"],
      "LASSO_NODE comes first, then the bundled runtime, then the build machine's Node")
check(Array(nodeSearchOrder.suffix(3)) == ["/nvm/v24.1.0/bin/node", "/nvm/v22.3.0/bin/node", "/nvm/v9.11.2/bin/node"],
      "nvm installs are tried newest first")
/// `installed` maps each existing Node to its version, or nil when it cannot run.
func resolveNode(_ installed: [String: String?], shellNode: String? = nil) -> (resolution: NodeResolution, askedShell: Bool) {
    var askedShell = false
    let resolution = selectNodeRuntime(
        candidates: nodeSearchOrder, bundledNode: bundledNode,
        isExecutable: { installed[$0] != nil },
        version: { installed[$0] ?? nil },
        loginShellNode: { askedShell = true; return shellNode })
    return (resolution, askedShell)
}
let bundledRuntime = NodeRuntime(path: bundledNode, version: "v24.13.0", isBundled: true)
let withoutInstalledNode = resolveNode([bundledNode: "v24.13.0"])
check(withoutInstalledNode.resolution == .found(bundledRuntime) && !withoutInstalledNode.askedShell,
      "the server starts on a Mac with no Node installed and LASSO_NODE pointing nowhere")
check(resolveNode([bundledNode: "v24.13.0", "/opt/homebrew/bin/node": "v25.0.0"]).resolution == .found(bundledRuntime),
      "the bundled runtime is preferred over an installed Node")
check(resolveNode(["/custom/node": "v25.1.0", bundledNode: "v24.13.0"]).resolution
      == .found(NodeRuntime(path: "/custom/node", version: "v25.1.0", isBundled: false)),
      "a working LASSO_NODE overrides the bundled runtime")
check(resolveNode([bundledNode: nil, "/usr/local/bin/node": "v24.2.0"]).resolution
      == .found(NodeRuntime(path: "/usr/local/bin/node", version: "v24.2.0", isBundled: false)),
      "a bundled runtime that cannot run falls back to an installed Node")
check(resolveNode([bundledNode: "v22.3.0", "/opt/homebrew/bin/node": "v24.0.0"]).resolution
      == .found(NodeRuntime(path: "/opt/homebrew/bin/node", version: "v24.0.0", isBundled: false)),
      "a bundled runtime that is too old is passed over")
let onlyOldNode = resolveNode([bundledNode: nil, "/opt/homebrew/bin/node": "v20.11.0"])
check(onlyOldNode.resolution == .tooOld(path: "/opt/homebrew/bin/node", version: "v20.11.0") && onlyOldNode.askedShell,
      "an old Node is reported with its version and path once the login shell finds nothing newer")
check(resolveNode([:], shellNode: "/fnm/node").resolution == .missing,
      "a login shell path that does not exist is not used")
check(resolveNode(["/fnm/node": "v24.0.0"], shellNode: "/fnm/node").resolution
      == .found(NodeRuntime(path: "/fnm/node", version: "v24.0.0", isBundled: false)),
      "the login shell finds Node installed by version managers")
check(resolveNode([:]).resolution == .missing, "no Node at all is reported as missing")
check(bundledRuntime.summary == "Node.js v24.13.0, bundled with Lasso"
      && NodeRuntime(path: "/usr/local/bin/node", version: "v24.2.0", isBundled: false).summary
      == "Node.js v24.2.0 from /usr/local/bin/node",
      "About Lasso and the server log say which Node runs the server")
check(nodeMajorVersion("v24.13.0") == 24 && nodeMajorVersion("v9.11.2\n") == 9 && nodeMajorVersion("") == 0,
      "Node versions compare by major number")

print("pinches over the source inspector reach its drawing")
do {
    let frame = NSRect(x: 100, y: 200, width: 560, height: 540)
    check(PinchRouting.quartzRect(for: frame, primaryScreenHeight: 1000)
          == CGRect(x: 100, y: 260, width: 560, height: 540),
          "the inspector's region is measured from the primary display's top, as the tap's locations are")
    check(PinchRouting.quartzRect(for: NSRect(x: -800, y: 1100, width: 560, height: 540), primaryScreenHeight: 1000)
          == CGRect(x: -800, y: -640, width: 560, height: 540),
          "an inspector on a display left of and above the primary one keeps negative Quartz coordinates")
    check(PinchRouting.wheelDelta(forMagnification: 0) == nil && PinchRouting.wheelDelta(forMagnification: -1) == nil
          && PinchRouting.wheelDelta(forMagnification: -1.5) == nil,
          "a pinch that has not moved, or an impossible scale, sends no wheel event")
    let spread = PinchRouting.wheelDelta(forMagnification: 0.1) ?? 0
    let squeeze = PinchRouting.wheelDelta(forMagnification: -0.1) ?? 0
    check(spread < 0 && squeeze > 0, "spreading fingers zooms in like a browser's Control + wheel up")
    check(abs(exp(spread * 0.01) * 1.1 - 1) < 1e-9,
          "the page's pinch speed turns a forwarded spread back into exactly the pinch's scale")
}

print("some of a line's words are chosen like a text field's, a word at a time")
do {
    // A sentence's continuation starts with the space after the typed words.
    let line = " 6061 aluminium with a 3 mm wall, anodised black."
    check(!AssistWordChoice.offers("Office supplies budget") && !AssistWordChoice.offers("first line\nsecond line here"),
          "names and several lines do not open into words")
    check(!AssistWordChoice.offers(line, from: "/Decks/Architecture-Overview.PPTX") && AssistWordChoice.offers(line, from: "/Notes/Close.md"),
          "a slide's line never opens to choose its words; its words are highlighted on the slide")
    check(AssistWordChoice.offers(line) && AssistWordChoice.offers("const total = await fetchTotal(id);"),
          "sentences and lines of code do")
    var words = AssistWordChoice(text: line)!
    check(words.words.count == 9 && words.isWhole && words.chosenText == line && !words.startsMidLine,
          "the line opens with every word selected, inserting exactly what Tab would")

    words.move(.backward, selecting: true)
    words.move(.backward, selecting: true)
    check(words.chosenText == " 6061 aluminium with a 3 mm wall", "⇧← takes words off the end, and the comma before them")
    words.move(.forward, selecting: true)
    check(words.chosenText == " 6061 aluminium with a 3 mm wall, anodised", "⇧→ gives a word back")

    var fromStart = AssistWordChoice(text: line, movingStart: true)!
    fromStart.move(.forward, selecting: true)
    fromStart.move(.forward, selecting: true)
    check(fromStart.chosenText == "with a 3 mm wall, anodised black." && fromStart.startsMidLine,
          "opened with ⇧fn←, ⇧→ takes words off the start, without the space they followed")

    // The middle: collapse to the start, move to the first word, select to the last.
    var middle = AssistWordChoice(text: line)!
    middle.move(.backward, selecting: false)
    check(middle.selection.isEmpty && middle.caret == 0 && middle.chosenText == nil,
          "← collapses the selection to its start, leaving nothing to insert")
    middle.move(.forward, selecting: false)
    middle.move(.forward, selecting: false)
    for _ in 0..<5 { middle.move(.forward, selecting: true) }
    check(middle.chosenText == "with a 3 mm wall", "words from the middle are moved to, then selected")
    middle.move(.backward, selecting: true, toEnd: true)
    check(middle.chosenText == " 6061 aluminium", "⇧⌘← selects from where the selection started back to the start")
    middle.move(.forward, selecting: true, toEnd: true)
    check(middle.chosenText == "with a 3 mm wall, anodised black.", "⇧⌘→ selects on to the end")
    middle.move(.forward, selecting: false)
    middle.move(.forward, selecting: false)
    check(middle.caret == 9 && middle.selection.isEmpty, "the caret stops at the end of the line")

    var dragged = AssistWordChoice(text: line)!
    dragged.select(from: 6, to: 3)
    check(dragged.chosenText == "a 3 mm wall", "dragging back over words selects them too")
    dragged.select(from: 4, to: 4)
    check(dragged.chosenText == "3", "a click selects one word")

    let code = AssistWordChoice(text: "if (total > limit) { return limit; }")!
    var condition = code
    condition.select(from: 0, to: 3)
    check(condition.chosenText == "if (total > limit)", "code is chosen by the runs between its spaces")
}

print("keystrokes are routed from a published snapshot")
do {
    func route(_ keyCode: Int64, _ state: KeyRoutingState) -> KeyDecision {
        KeyRouter.decide(keyCode: keyCode, flags: [], synthetic: false, state: state)
    }
    func chord(_ keyCode: Int64, _ flags: CGEventFlags, _ state: KeyRoutingState) -> KeyDecision {
        KeyRouter.decide(keyCode: keyCode, flags: flags, synthetic: false, state: state)
    }
    let idle = KeyRoutingState()
    check(route(0, idle) == .pass(.followTyping(trackCaret: false)),
          "typing with nothing open passes the key and schedules a suggestion")
    check(KeyRouter.decide(keyCode: 0, flags: [], synthetic: true, state: KeyRoutingState(popup: .suggestions)) == .pass(nil),
          "Lasso's own synthesized keys pass untouched")
    check(route(48, KeyRoutingState(isInserting: true, popup: .suggestions)) == .pass(nil),
          "every key passes while an insertion is typing")
    check(route(53, idle) == .pass(.escapePassed), "Escape with nothing open reaches the host, as vim needs")
    check(chord(8, .maskCommand, idle) == .pass(.hide), "shortcuts reach the host and close any pending box")

    let open = KeyRoutingState(popup: .suggestions)
    check(route(48, open) == .swallow(.activate), "Tab accepts a visible suggestion")
    check(chord(48, .maskShift, open) == .pass(.hide), "Shift+Tab leaves the field and closes the box")
    check(chord(48, .maskControl, open) == .pass(.hide), "Control+Tab switches tabs and closes the box")
    check(route(126, open) == .swallow(.move(-1)) && route(125, open) == .swallow(.move(1)),
          "bare arrows move through suggestions")
    check(chord(125, .maskAlternate, open) == .pass(.hide), "Option+Down selects text instead")
    check(chord(36, .maskCommand, open) == .swallow(.acceptPlain), "Command+Return inserts plain text")
    check(chord(76, [.maskCommand, .maskShift], open) == .swallow(.acceptShared), "Shift+Command+Enter shares")
    check(route(36, open) == .pass(.followTyping(trackCaret: true)), "Return alone belongs to the host")
    // macOS delivers fn+← as Home (115) and fn+→ as End (119), with the fn flag.
    let fnArrow: CGEventFlags = [.maskSecondaryFn]
    // The main thread decides whether there is a level to move to; at the top
    // or the bottom the key does nothing, rather than move the host's caret.
    check(chord(115, fnArrow, open) == .swallow(.focusOut), "fn+Left on the card steps its focus back a level")
    check(chord(119, fnArrow, open) == .swallow(.focusIn), "fn+Right on the card narrows its focus a level")
    check(chord(123, [.maskShift, .maskNumericPad, .maskSecondaryFn], open) == .pass(.followTyping(trackCaret: true))
          && chord(124, [.maskShift, .maskNumericPad, .maskSecondaryFn], open) == .pass(.followTyping(trackCaret: true)),
          "Shift+arrows select text even while the card is up")
    check(chord(115, [.maskSecondaryFn, .maskShift], open) == .pass(.followTyping(trackCaret: true)),
          "Shift+fn+Left still selects to the start")
    check(chord(115, fnArrow, idle) == .pass(.followTyping(trackCaret: false))
          && chord(119, fnArrow, idle) == .pass(.followTyping(trackCaret: false)),
          "with no card on screen, fn+arrows belong to the host")
    check(chord(119, fnArrow, KeyRoutingState(popup: .confirmShare)) == .pass(.followTyping(trackCaret: true)),
          "the share question leaves fn+arrows to the host")
    let tableRow = KeyRoutingState(popup: .suggestions, tableNavigable: true)
    check(chord(119, fnArrow, tableRow) == .swallow(.navigateTable(KeyRouter.diveDirection)),
          "on a sheet's suggestion, fn+Right dives in where the suggestion is")
    check(chord(115, fnArrow, tableRow) == .swallow(.focusOut), "before diving in, fn+Left steps the card back")
    check(route(125, tableRow) == .swallow(.move(1)), "before diving in, bare Down still chooses suggestions")
    let table = KeyRoutingState(popup: .suggestions, tableNavigable: true, tableBrowsing: true)
    for (key, direction) in [(123, "left"), (124, "right"), (126, "up"), (125, "down")] {
        check(chord(Int64(key), [.maskNumericPad, .maskSecondaryFn], table) == .swallow(.navigateTable(direction)),
              "inside a sheet the bare arrows move a cell at a time")
    }
    check(chord(119, fnArrow, table) == .swallow(.returnFromTable), "inside a sheet fn+Right goes back to the suggestions")
    check(chord(115, fnArrow, table) == .swallow(.returnFromTable), "inside a sheet fn+Left goes back too")
    for (key, direction) in [(116, "up"), (121, "down")] {
        check(chord(Int64(key), fnArrow, table) == .swallow(.navigateTable(direction)), "inside a sheet fn+Up and fn+Down still move")
    }
    check(route(53, table) == .swallow(.returnFromTable), "Escape returns from table browsing to the original suggestions")
    check(chord(121, fnArrow, open) == .pass(.followTyping(trackCaret: true)),
          "Fn Down remains with the host outside tables")
    check(chord(119, [.maskShift, .maskSecondaryFn], table) == .pass(.followTyping(trackCaret: true)),
          "modified table arrows still belong to text selection")
    check(chord(119, fnArrow, KeyRoutingState(shareComposerOpen: true, popup: .suggestions, tableNavigable: true)) == .pass(nil),
          "share controls take priority over table navigation")
    let empty = KeyRoutingState(popup: .suggestions, offersChoices: false)
    check(chord(119, fnArrow, empty) == .swallow(.focusIn), "an empty card kept after a move still moves back with fn+Right")
    check(route(48, empty) == .pass(.followTyping(trackCaret: true)) && route(125, empty) == .pass(.followTyping(trackCaret: true))
          && chord(36, .maskCommand, empty) == .pass(.hide),
          "an empty card leaves Tab, arrows and Command+Return to the host")
    check(route(53, KeyRoutingState(transientOpen: true, popup: .suggestions)) == .swallow(.dismissTransient),
          "Escape still only closes the card")
    check(route(0, open) == .pass(.followTyping(trackCaret: true)), "typing keeps the open box on the caret")

    let confirming = KeyRoutingState(popup: .confirmShare)
    check(route(36, confirming) == .swallow(.resolveConfirmation), "Return answers the share question")
    check(route(48, confirming) == .swallow(.activate), "Tab answers the share question")
    let message = KeyRoutingState(popup: .message)
    check(route(48, message) == .pass(.followTyping(trackCaret: true)), "a message never takes Tab")

    let dismissible = KeyRoutingState(transientOpen: true, popup: .suggestions)
    check(route(53, dismissible) == .swallow(.dismissTransient), "Escape closes an open Lasso surface")
    check(chord(53, .maskShift, dismissible) == .swallow(.dismissTransient), "Shift+Escape still closes it")
    check(chord(53, .maskCommand, dismissible) == .pass(.escapePassed), "Command+Escape belongs to the host")

    let choosing = KeyRoutingState(transientOpen: true, sourceChooserVisible: true, popup: .suggestions)
    check(route(48, choosing) == .pass(nil) && route(0, choosing) == .pass(nil),
          "the source chooser's search field owns its keys")
    let sharing = KeyRoutingState(transientOpen: true, shareComposerOpen: true, popup: .suggestions)
    check(route(48, sharing) == .swallow(.shareConfirm) && route(36, sharing) == .swallow(.shareConfirm),
          "Tab and Return confirm the share options")
    check(chord(48, .maskShift, sharing) == .pass(nil), "Shift+Tab passes while sharing")
    check(route(123, sharing) == .swallow(.shareScope(-1)) && route(125, sharing) == .swallow(.shareScope(1)),
          "arrows change the share scope")
    check(chord(36, .maskCommand, sharing) == .pass(nil) && route(0, sharing) == .pass(nil),
          "modified keys and typing reach the host while sharing")
    let inspectorSharing = KeyRoutingState(transientOpen: true, shareComposerOpen: true, inspectorCanShare: true)
    check(route(48, inspectorSharing) == .swallow(.shareConfirm) && route(124, inspectorSharing) == .swallow(.shareScope(1)),
          "share options opened from the inspector take Tab, Return and arrows from the focused app")
    check(route(53, inspectorSharing) == .swallow(.dismissTransient), "Escape closes share options opened from the inspector")
    check(chord(6, .maskCommand, sharing) == .swallow(.shareUndo)
          && chord(6, [.maskCommand, .maskShift], sharing) == .swallow(.shareRedo),
          "Command+Z and Shift+Command+Z step through the masks, not the document behind them")
    check(chord(6, [.maskCommand, .maskAlternate], sharing) == .pass(nil) && route(6, sharing) == .pass(nil),
          "other Z chords and a bare Z are not mask undo")

    let justInserted = KeyRoutingState(canUndoInsertion: true)
    check(chord(6, .maskCommand, justInserted) == .swallow(.undoInsertion),
          "Command+Z right after an insertion takes it back")
    check(chord(6, .maskCommand, KeyRoutingState(popup: .message, canUndoInsertion: true)) == .swallow(.undoInsertion),
          "the insertion's confirmation does not stop Command+Z")
    check(chord(6, [.maskCommand, .maskShift], justInserted) == .pass(.hide) && chord(6, .maskCommand, idle) == .pass(.hide),
          "redo, and undo after anything else, belong to the host")
    check(chord(6, .maskCommand, KeyRoutingState(isInserting: true, canUndoInsertion: true)) == .pass(nil),
          "Command+Z passes while an insertion is still typing")

    let inspecting = KeyRoutingState(transientOpen: true, inspectorCanShare: true)
    check(route(48, inspecting) == .swallow(.inspectorShare), "Tab opens the inspector's Share Link, not a Tab in the host")
    check(chord(48, .maskShift, inspecting) != .swallow(.inspectorShare)
          && chord(48, .maskControl, inspecting) == .pass(.hide),
          "Shift+Tab and Control+Tab still belong to the host while inspecting")
    check(route(0, inspecting) == .pass(.followTyping(trackCaret: false)), "typing still reaches the host while inspecting")
    check(route(48, KeyRoutingState(transientOpen: true, inspectorCanShare: true, popup: .suggestions)) == .swallow(.activate),
          "a suggestion shown while inspecting keeps Tab")
    check(route(48, KeyRoutingState(transientOpen: true, inspectorCanShare: true, popup: .message)) == .swallow(.inspectorShare),
          "a message beside the inspector does not take its Tab")
    check(route(48, KeyRoutingState(transientOpen: true)) == .pass(.followTyping(trackCaret: false)),
          "an inspector still loading or showing an error leaves Tab to the host")

    // ⇧fn+arrows arrive as Shift+Home and Shift+End.
    let shiftFn: CGEventFlags = [.maskSecondaryFn, .maskShift]
    let line = KeyRoutingState(transientOpen: true, popup: .suggestions, highlightsLine: true)
    check(chord(119, shiftFn, line) == .swallow(.openWords(movingStart: false))
          && chord(115, shiftFn, line) == .swallow(.openWords(movingStart: true)),
          "⇧fn+Right and ⇧fn+Left open a highlighted line's words")
    check(chord(115, shiftFn, open) == .pass(.followTyping(trackCaret: true)),
          "on any other row ⇧fn+Left still selects to the start in the host")
    check(chord(119, fnArrow, line) == .swallow(.focusIn) && chord(115, fnArrow, line) == .swallow(.focusOut),
          "fn+Left and fn+Right keep narrowing and stepping back on a line")
    check(chord(119, [.maskSecondaryFn, .maskShift, .maskCommand], line) == .pass(.hide),
          "Shift+Command+End is not taken for a line")
    let words = KeyRoutingState(transientOpen: true, popup: .suggestions, highlightsLine: true, choosingWords: true)
    let arrowFlags: CGEventFlags = [.maskNumericPad, .maskSecondaryFn]
    check(chord(124, arrowFlags, words) == .swallow(.moveInWords(forward: true, selecting: false, toEnd: false))
          && chord(123, arrowFlags, words) == .swallow(.moveInWords(forward: false, selecting: false, toEnd: false)),
          "among a line's words the arrows move a word, not the host's caret")
    check(chord(123, arrowFlags.union(.maskShift), words) == .swallow(.moveInWords(forward: false, selecting: true, toEnd: false))
          && chord(124, arrowFlags.union([.maskShift, .maskAlternate]), words)
            == .swallow(.moveInWords(forward: true, selecting: true, toEnd: false)),
          "Shift+arrows select a word at a time, with or without Option")
    check(chord(124, arrowFlags.union([.maskShift, .maskCommand]), words)
            == .swallow(.moveInWords(forward: true, selecting: true, toEnd: true))
          && chord(115, shiftFn, words) == .swallow(.moveInWords(forward: false, selecting: true, toEnd: true)),
          "Shift+Command+arrows and ⇧fn+arrows select to the start or end")
    check(chord(115, fnArrow, words) == .swallow(.focusOut) && chord(119, fnArrow, words) == .swallow(.focusIn),
          "fn+Left and fn+Right still step and narrow the card from a line's words")
    check(route(53, words) == .swallow(.closeWords) && route(53, line) == .swallow(.dismissTransient),
          "Escape goes back from a line's words to the list, then closes the card")
    check(route(48, words) == .swallow(.activate) && chord(36, .maskCommand, words) == .swallow(.acceptPlain)
          && route(125, words) == .swallow(.move(1)),
          "Tab and Command+Return insert the words, and Down goes on to the next row")
    check(chord(124, arrowFlags.union(.maskControl), words) == .pass(.hide)
          && route(0, words) == .pass(.followTyping(trackCaret: true)),
          "Control+arrows and typing still reach macOS and the host")
    check(chord(124, arrowFlags, KeyRoutingState(shareComposerOpen: true, popup: .suggestions, choosingWords: true))
            == .swallow(.shareScope(1)),
          "the share options keep their arrows over a line's words")

    let box = KeyRoutingStateBox()
    box.value = open
    var seen: KeyRoutingState?
    let read = DispatchSemaphore(value: 0)
    Thread { seen = box.value; read.signal() }.start()
    read.wait()
    check(seen == open, "the tap thread reads the state the main thread published")
}

print("fn+Left and fn+Right move the card's focus out and in")
do {
    func source(_ id: String, _ text: String, project: String = "cad") -> LinkedSourceMemory.Source {
        LinkedSourceMemory.Source(projectId: project, objectId: id, snapshotId: "snap-\(id)", text: text)
    }
    func focus(_ fields: [String: Any]) -> [String: Any]? { fields["focusSource"] as? [String: Any] }
    func focusId(_ fields: [String: Any]) -> String? { focus(fields)?["sourceObjectId"] as? String }
    func focusWords(_ fields: [String: Any]) -> Range<Int>? {
        guard let start = focus(fields)?["start"] as? Int, let end = focus(fields)?["end"] as? Int else { return nil }
        return start..<end
    }
    func pendingIds(_ fields: [String: Any]) -> [String] {
        (fields["pendingDependencies"] as? [[String: Any]] ?? []).compactMap { $0["sourceObjectId"] as? String }
    }
    /// The words typed to find a row, as the card reads them from the text it answered.
    func words(_ text: String, _ typed: String) -> TextAnchor? {
        let units = Array(text.utf16), start = units.count - typed.utf16.count
        return TextAnchor.make(in: units, range: start..<units.count)
    }
    /// Tab inserts the source's text at the end of `before`, as the card does.
    func accept(_ memory: inout LinkedSourceMemory, _ accepted: LinkedSourceMemory.Source, after before: String) -> String {
        let units = Array((before + accepted.text).utf16)
        memory.record(accepted, in: units, at: (units.count - accepted.text.utf16.count)..<units.count)
        return before + accepted.text
    }
    let bracket = source("bracket", "Bracket"), hole = source("hole", "Bracket Ø8 hole diameter")
    var memory = LinkedSourceMemory()
    check(!memory.canMoveIn(focusedOn: nil, selected: nil), "with nothing used yet, fn+Right has nowhere to go")
    _ = accept(&memory, bracket, after: "The ")
    memory.observe("The Bracket beside the Bracket is", reachesStart: true)
    let pending = memory.requestFields["pendingDependencies"] as? [[String: Any]] ?? []
    check(pending.count == 1 && pending[0]["start"] as? Int == 4 && pending[0]["end"] as? Int == 11
          && pending[0]["sourceObjectId"] as? String == "bracket" && pending[0]["sourceSnapshotId"] as? String == "snap-bracket",
          "an accepted source is sent where it was inserted, not at a later repeat of its text")
    memory.observe("The plate is", reachesStart: true)
    check(memory.requestFields.isEmpty, "a source whose text was deleted is not sent")
    var emoji = LinkedSourceMemory()
    _ = accept(&emoji, bracket, after: "📐 ")
    emoji.observe("📐 Bracket is", reachesStart: true)
    check((emoji.requestFields["pendingDependencies"] as? [[String: Any]])?.first?["start"] as? Int == 3,
          "offsets count UTF-16 units, as the host's text does")
    memory.observe("The Bracket is", reachesStart: true)
    let accepted = memory.requestFields
    check(accepted["pendingDependencies"] != nil && accepted["focusSource"] == nil,
          "an accepted source is sent for the server to keep while its sentence goes on")

    memory.moveOut(from: bracket)
    check(memory.requestFields.isEmpty, "fn+Left sends no source, so every directory answers the next words")
    check(memory.canMoveIn(focusedOn: nil, selected: nil),
          "from all directories fn+Right can return to the last focus")
    memory.endMove()
    memory.moveIn(focusedOn: nil, selected: nil)
    memory.observe("The Bracket is shown on the plate. It is", reachesStart: true)
    let back = memory.requestFields
    check(focusId(back) == "bracket" && back["pendingDependencies"] == nil
          && (back["focusSource"] as? [String: Any])?["sourceSnapshotId"] as? String == "snap-bracket",
          "with no highlighted row that has values below it, fn+Right from all directories returns to the last focus")

    check(!memory.canMoveIn(focusedOn: bracket, selected: bracket) && !memory.canMoveIn(focusedOn: bracket, selected: nil),
          "a focused card has nowhere further to go without another row selected")
    memory.noteFocus(bracket)
    memory.moveIn(focusedOn: bracket, selected: hole)
    check(focusId(memory.requestFields) == "hole" && memory.recent == hole && memory.stepBack == bracket,
          "fn+Right on a focused card narrows it to the selected row, and fn+Left would step back to the card's focus")
    memory.noteFocus(hole)
    memory.moveOut(from: hole)
    check(focusId(memory.requestFields) == "bracket", "fn+Left steps back to the focus the row was chosen on")
    memory.noteFocus(bracket)
    check(memory.canMoveIn(focusedOn: bracket, selected: hole) && memory.stepBack == nil,
          "back on the focus, fn+Right can narrow to the row again, and fn+Left goes on to every directory")
    memory.moveIn(focusedOn: bracket, selected: hole)
    check(focusId(memory.requestFields) == "hole", "fn+Left then fn+Right returns to the narrowed focus")

    // Tab on Invoice lists its values; Tab on one of them leaves that list on the card.
    let invoice = source("invoice", "Invoice"), bill = source("bill-1160", "BILL-1160")
    var held = LinkedSourceMemory()
    let invoiceText = accept(&held, invoice, after: "")
    held.noteFocus(invoice)
    let billText = accept(&held, bill, after: invoiceText + " had values, it was ")
    held.observe(billText + " and ", reachesStart: true)
    held.noteFocus(invoice)
    check(held.stepBack == nil, "fn+Left from a list a value was tabbed from goes to every directory")
    held.moveOut(from: invoice)
    let widened = held.requestFields, billEnd = billText.utf16.count
    check(pendingIds(widened).isEmpty && widened["settledValueEnd"] as? Int == billEnd
          && widened["sourceScopeBoundary"] as? Int == billEnd,
          "one fn+Left drops the list and the value tabbed from it, and the words after the value go to every directory")
    check(held.canMoveIn(focusedOn: nil, selected: nil) && held.recent == invoice,
          "fn+Right goes back into the list")

    // With row mates added from a tabbed sheet cell, one fn+Left exits back to Invoice's own values,
    // and a second fn+Left widens to every directory.
    let bill2 = source("bill-1190", "BILL-1190"), amount = source("amount-22000", "22000")
    var rowMates = LinkedSourceMemory()
    let invText = accept(&rowMates, invoice, after: "")
    rowMates.noteFocus(invoice)
    let b1Text = accept(&rowMates, bill, after: invText + " was ")
    rowMates.observe(b1Text + " and ", reachesStart: true)
    rowMates.noteFocus(invoice, hasRowMates: true)
    let b1End = b1Text.utf16.count
    check(rowMates.stepBack == invoice,
          "while row mates are shown, fn+Left names the kept column as the first step back")
    rowMates.moveOut(from: invoice)
    let invoiceOnlyFields = rowMates.requestFields
    check(pendingIds(invoiceOnlyFields) == ["invoice", "bill-1160"]
          && invoiceOnlyFields["rowScopeBoundary"] as? Int == b1End
          && invoiceOnlyFields["settledValueEnd"] == nil
          && rowMates.stepBack == nil,
          "first fn+Left drops the tabbed cell's row mates and stays on Invoice's own values")
    rowMates.noteFocus(invoice, hasRowMates: false)
    check(rowMates.requestFields["rowScopeBoundary"] as? Int == b1End && rowMates.stepBack == nil,
          "after the server returns Invoice alone, rowScopeBoundary stays and the next fn+Left goes to all directories")
    rowMates.moveOut(from: invoice)
    let allDirsFields = rowMates.requestFields
    check(pendingIds(allDirsFields).isEmpty
          && allDirsFields["rowScopeBoundary"] == nil
          && allDirsFields["settledValueEnd"] as? Int == b1End
          && allDirsFields["sourceScopeBoundary"] as? Int == b1End,
          "second fn+Left exits Invoice and widens to all active directories")
    check(rowMates.canMoveIn(focusedOn: nil, selected: nil) && rowMates.recent == invoice,
          "fn+Right from all directories can return to Invoice")
    rowMates.moveIn(focusedOn: nil, selected: nil)
    check(pendingIds(rowMates.requestFields) == ["invoice", "bill-1160"]
          && rowMates.requestFields["rowScopeBoundary"] as? Int == b1End,
          "fn+Right straight after stepping out of Invoice returns to Invoice's own values")

    // Tabbing another invoice after exiting the first cell's row mates brings only the new cell's row mates.
    var nextBill = LinkedSourceMemory()
    let nextInv = accept(&nextBill, invoice, after: "")
    nextBill.noteFocus(invoice)
    let firstTab = accept(&nextBill, bill, after: nextInv + " was ")
    nextBill.observe(firstTab + " and ", reachesStart: true)
    nextBill.noteFocus(invoice, hasRowMates: true)
    nextBill.moveOut(from: invoice)
    nextBill.noteFocus(invoice, hasRowMates: false)
    let secondTab = accept(&nextBill, bill2, after: firstTab + " and ")
    nextBill.observe(secondTab + " for ", reachesStart: true)
    check(pendingIds(nextBill.requestFields) == ["invoice", "bill-1160", "bill-1190"]
          && nextBill.requestFields["rowScopeBoundary"] as? Int == firstTab.utf16.count,
          "tabbing a second bill keeps the earlier rowScopeBoundary so only the new row joins")
    nextBill.noteFocus(invoice, hasRowMates: true)
    check(nextBill.stepBack == invoice, "the new bill's row mates step back to Invoice first")
    // Rapid double fn+Left without waiting for the server steps out of row mates then out of Invoice.
    nextBill.moveOut(from: invoice)
    check(nextBill.requestFields["rowScopeBoundary"] as? Int == secondTab.utf16.count
          && nextBill.stepBack == nil,
          "first rapid fn+Left advances rowScopeBoundary past the second bill")
    nextBill.moveOut(from: invoice)
    check(pendingIds(nextBill.requestFields).isEmpty
          && nextBill.requestFields["settledValueEnd"] as? Int == secondTab.utf16.count,
          "second rapid fn+Left exits Invoice to all active directories")

    // Tabbing a row mate (22000) keeps Invoice; two fn+Left steps still exit row mates then Invoice.
    var mateTab = LinkedSourceMemory()
    let mateInv = accept(&mateTab, invoice, after: "")
    mateTab.noteFocus(invoice)
    let mateBill = accept(&mateTab, bill, after: mateInv + " was ")
    mateTab.observe(mateBill + " for ", reachesStart: true)
    mateTab.noteFocus(invoice, hasRowMates: true)
    let mateAmt = accept(&mateTab, amount, after: mateBill + " for ")
    mateTab.observe(mateAmt + " on ", reachesStart: true)
    mateTab.noteFocus(invoice, hasRowMates: true)
    mateTab.moveOut(from: invoice)
    check(mateTab.requestFields["rowScopeBoundary"] as? Int == mateAmt.utf16.count
          && pendingIds(mateTab.requestFields) == ["invoice", "bill-1160", "amount-22000"],
          "first fn+Left after tabbing a row mate drops row mates past the row mate")
    mateTab.moveOut(from: invoice)
    check(pendingIds(mateTab.requestFields).isEmpty
          && mateTab.requestFields["settledValueEnd"] as? Int == mateAmt.utf16.count,
          "second fn+Left after tabbing a row mate exits to all active directories")

    // Top-right label layout keeps "From BILL-1160" unclipped beside short and medium values,
    // while preserving legible room for very long labels.
    let labelFont = NSFont.systemFont(ofSize: 12.5, weight: .semibold)
    let detailFont = NSFont.systemFont(ofSize: 11.5, weight: .medium)
    let shortRow = AssistRowTitleLayout(label: "22000", detail: "From BILL-1160",
                                        available: 273, labelFont: labelFont, detailFont: detailFont)
    let fullDetailWidth = ceil(AssistTableLayout.textWidth("From BILL-1160", detailFont)) + 1
    check(shortRow.detailWidth == fullDetailWidth && shortRow.labelWidth + AssistRowTitleLayout.gap + shortRow.detailWidth <= 273,
          "top-right row-mate label fits whole beside a short value")
    let supplierRow = AssistRowTitleLayout(label: "Maple Paper Distribution", detail: "From BILL-1160",
                                           available: 273, labelFont: labelFont, detailFont: detailFont)
    check(supplierRow.detailWidth == fullDetailWidth,
          "top-right row-mate label still fits whole beside a supplier name")
    let crowdedRow = AssistRowTitleLayout(label: String(repeating: "A", count: 40),
                                          detail: "From " + String(repeating: "B", count: 40),
                                          available: 273, labelFont: labelFont, detailFont: detailFont)
    check(crowdedRow.detailWidth >= AssistRowTitleLayout.minimumDetailWidth
          && crowdedRow.labelWidth + AssistRowTitleLayout.gap + crowdedRow.detailWidth <= 273,
          "a very long label and detail both keep visible width without overlapping")
    let supplierName = "Maple Paper Distribution"
    let describedRow = AssistRowTitleLayout(label: supplierName, detail: "Row · Invoice BILL-1160, Invoice Date 2026-08-18",
                                            available: 273, labelFont: labelFont, detailFont: detailFont)
    check(describedRow.labelWidth >= ceil(AssistTableLayout.textWidth(supplierName, labelFont)) + 1
          && describedRow.detailWidth > 0
          && describedRow.labelWidth + AssistRowTitleLayout.gap + describedRow.detailWidth <= 273,
          "a long description is shortened beside a title, never the title")
    let narrowRow = AssistRowTitleLayout(label: String(repeating: "Maple ", count: 6), detail: "Invoice column · Maple Paper…",
                                         available: 200, labelFont: labelFont, detailFont: detailFont)
    check(narrowRow.detailWidth == 0 || narrowRow.detailWidth >= AssistRowTitleLayout.minimumDetailWidth,
          "a description too squeezed to read is left out rather than crammed against the title")
    let partedRow = AssistRowTitleLayout(label: supplierName, detail: "Row · Invoice BILL-1160",
                                         available: 273, labelFont: labelFont, detailFont: detailFont, dropsParts: true)
    let tightRow = AssistRowTitleLayout(label: supplierName, detail: "Row · Invoice BILL-1160 · Invoice Date 2026-08-18",
                                        available: 273, labelFont: labelFont, detailFont: detailFont, dropsParts: true)
    check([partedRow, tightRow].allSatisfy { row in
              row.detailWidth >= ceil(AssistTableLayout.textWidth(row.detail, detailFont)) + 1
              && row.detail.hasPrefix("Row")
          } && tightRow.detail != "Row · Invoice BILL-1160 · Invoice Date 2026-08-18",
          "a description too long beside its title drops whole parts instead of ending mid-value")
    let changeRow = AssistRowTitleLayout(label: supplierName, detail: "19,250 · was 18,400 since Tuesday",
                                         available: 273, labelFont: labelFont, detailFont: detailFont)
    check(changeRow.detail == "19,250 · was 18,400 since Tuesday",
          "a value's change keeps all its parts, shortened at the end if it must be")
    let valueRow = AssistRowTitleLayout(label: String(repeating: "October forecast ", count: 4), detail: "190000",
                                        available: 273, labelFont: labelFont, detailFont: detailFont)
    check(valueRow.detailWidth == ceil(AssistTableLayout.textWidth("190000", detailFont)) + 1,
          "a short value beside a long title still shows whole")

    let revenueText = accept(&memory, source("revenue", "Revenue", project: "finance"), after: "The Bracket is shown. ")
    memory.observe(revenueText + " was", reachesStart: true)
    check(focusId(memory.requestFields) == nil && memory.requestFields["pendingDependencies"] != nil,
          "a source accepted with Tab replaces a focus chosen with fn+Right")
    memory.moveIn(focusedOn: nil, selected: nil)
    memory.forget()
    check(memory.sources.isEmpty && memory.requestFields.isEmpty
          && !memory.canMoveIn(focusedOn: nil, selected: nil),
          "a new field starts with nothing focused and no focus from an earlier field to return to")
    let width = source("width", "100 mm"), budget = source("budget", "September Budget CAD", project: "finance")
    memory.noteFocus(bracket)
    let widthText = accept(&memory, width, after: "The Bracket is ")
    check(memory.sources.last == width && memory.recent == bracket,
          "a value tabbed on a focused card is sent, and fn+Right returns to the card's focus, not the value")
    _ = accept(&memory, budget, after: widthText + " and ")
    memory.noteFocus(budget)
    check(memory.recent == budget, "a deeper focus the card then shows becomes fn+Right's way back")

    var text = ""
    for index in 0..<10 {
        // The card shows each part's values once it is tabbed.
        let part = source("part-\(index)", "Part \(index)")
        text = accept(&memory, part, after: text + " ")
        memory.noteFocus(part)
    }
    check(memory.sources.count == 8 && memory.sources.first?.objectId == "part-2",
          "only the eight newest accepted sources are kept")
    _ = accept(&memory, source("revenue", "Revenue", project: "finance"), after: text + " ")
    memory.noteFocus(source("revenue", "Revenue", project: "finance"))
    memory.keep(projectIds: ["cad"])
    check(memory.sources.count == 7 && memory.sources.allSatisfy { $0.projectId == "cad" }
          && memory.recent?.projectId == "cad",
          "sources in a directory that was removed are dropped, and fn+Right returns to the focus before them")
    memory.keep(projectIds: [])
    check(memory.recent == nil && !memory.canMoveIn(focusedOn: nil, selected: nil),
          "with every directory removed fn+Right has nowhere to go")

    // "brac" offers Bracket; fn+Right opens its measurements, which replace "brac".
    var lookup = LinkedSourceMemory()
    let typed = "Hi Sam, the brac"
    lookup.observe(typed, reachesStart: true)
    check(lookup.canMoveIn(focusedOn: nil, selected: bracket), "fn+Right can open the highlighted row")
    let plate = source("plate", "Plate")
    var highlighted = lookup
    highlighted.noteFocus(bracket)
    _ = accept(&highlighted, plate, after: "The ")
    highlighted.observe("The Plate is. Hi Sam, the brac", reachesStart: true)
    check(highlighted.canMoveIn(focusedOn: nil, selected: bracket),
          "a highlighted row with values below it comes before the way back to the last focus")
    lookup.moveIn(focusedOn: nil, selected: bracket, typed: words(typed, "brac"))
    check(focusId(lookup.requestFields) == "bracket" && focusWords(lookup.requestFields) == 12..<16
          && lookup.requestFields["pendingDependencies"] == nil,
          "fn+Right focuses the highlighted row on the words typed to find it")
    lookup.noteFocus(bracket)
    lookup.observe(typed + " ho", reachesStart: true)
    check(focusWords(lookup.requestFields) == 12..<16, "words typed after fn+Right leave the focus on the typed words")
    check(!lookup.canMoveIn(focusedOn: bracket, selected: nil) && !lookup.canMoveIn(focusedOn: bracket, selected: bracket),
          "on the part's measurements fn+Right does nothing: a value has nothing below it")
    lookup.moveOut(from: bracket)
    check(lookup.requestFields.isEmpty, "fn+Left steps back out to every directory")
    lookup.noteFocus(nil)
    lookup.moveIn(focusedOn: nil, selected: nil)
    check(focusId(lookup.requestFields) == "bracket" && focusWords(lookup.requestFields) == 12..<16,
          "fn+Left then fn+Right returns to the same focus on the same words")
    lookup.observe("Hi Sam, the bra", reachesStart: true)
    check(lookup.requestFields.isEmpty, "deleting the typed words ends the focus chosen on them")
    let retyped = "Hi Sam, the pla"
    lookup.observe(retyped, reachesStart: true)
    lookup.endMove()
    lookup.moveIn(focusedOn: nil, selected: plate, typed: words(retyped, "pla"))
    check(focusId(lookup.requestFields) == "plate" && focusWords(lookup.requestFields) == 12..<15,
          "after deleting the typed words, fn+Right on the next words typed opens their row")
    var chosenWords = LinkedSourceMemory()
    chosenWords.observe("📐 brac", reachesStart: true)
    chosenWords.moveIn(focusedOn: nil, selected: bracket, typed: words("📐 brac", "brac"))
    check(focusWords(chosenWords.requestFields) == 3..<7, "typed words are sent in UTF-16 units too")

    // Tab on a value replaces the typed words: the value is accepted, and the
    // focus fn+Right chose is where fn+Left and fn+Right lead back to.
    var replaced = LinkedSourceMemory()
    replaced.observe("brac", reachesStart: true)
    replaced.moveIn(focusedOn: nil, selected: bracket, typed: words("brac", "brac"))
    replaced.noteFocus(bracket)
    _ = accept(&replaced, source("width", "100 mm"), after: "")
    check(focusId(replaced.requestFields) == nil && pendingIds(replaced.requestFields) == ["width"]
          && replaced.recent == bracket && replaced.stepBack == bracket,
          "Tab on a value ends the focus fn+Right chose on the typed words, without undoing it")
    replaced.moveOut(from: nil)
    check(focusId(replaced.requestFields) == "bracket" && focusWords(replaced.requestFields) == nil,
          "fn+Left out of that Tab returns to the part, whose typed words the value took the place of")

    // Undo in the host after that Tab brings the typed words back, and the focus rests on them again.
    var undoTab = LinkedSourceMemory()
    let typedReven = "Hi Sam, the Reven", revenue = source("revenue", "Revenue", project: "finance")
    undoTab.observe(typedReven, reachesStart: true)
    undoTab.moveIn(focusedOn: nil, selected: revenue, typed: words(typedReven, "Reven"))
    undoTab.noteFocus(revenue)
    _ = accept(&undoTab, source("revenue-value", "485000", project: "finance"), after: "Hi Sam, the ")
    check(focusId(undoTab.requestFields) == nil && pendingIds(undoTab.requestFields) == ["revenue-value"],
          "Tab on the value ends the focus chosen on the typed words")
    undoTab.observe(typedReven, reachesStart: true)
    check(focusId(undoTab.requestFields) == "revenue" && focusWords(undoTab.requestFields) == 12..<17,
          "undoing the Tab returns to the focus on the typed words, which its values replace again")

    // Right after fn+Left, fn+Right goes back into the level it left, even one with nothing below it.
    let facilities = source("facilities", "Facilities", project: "finance")
    let budgetCell = source("facilities-budget", "September Budget CAD", project: "finance")
    var tabbed = LinkedSourceMemory()
    var said = accept(&tabbed, facilities, after: "")
    tabbed.noteFocus(facilities)
    said = accept(&tabbed, budgetCell, after: said + " for the ")
    tabbed.observe(said, reachesStart: true)
    tabbed.noteFocus(budgetCell)
    tabbed.moveOut(from: budgetCell)
    tabbed.noteFocus(facilities)
    check(tabbed.steppedOutOf == budgetCell && !tabbed.canMoveIn(focusedOn: facilities, selected: nil)
          && tabbed.canMoveIn(focusedOn: facilities, selected: nil, highlighted: budgetCell),
          "after fn+Left the row it stepped out of can be gone back into, though nothing is below it")
    check(tabbed.moveIn(focusedOn: facilities, selected: nil, highlighted: budgetCell) == budgetCell
          && pendingIds(tabbed.requestFields) == ["facilities", "facilities-budget"] && tabbed.steppedOutOf == nil,
          "fn+Right then undoes fn+Left, back into the tabbed column item")

    // Two fn+Left presses are undone by two fn+Right presses, each back into the level left.
    let column = source("invoice-date", "Invoice date", project: "accounts")
    let payables = source("payables", "Accounts-Payable.csv", project: "accounts")
    var history = LinkedSourceMemory()
    _ = accept(&history, payables, after: "See ")
    history.noteFocus(payables)
    history.moveIn(focusedOn: payables, selected: column)
    history.noteFocus(column)
    history.moveOut(from: column)
    history.noteFocus(payables)
    history.moveOut(from: payables)
    history.noteFocus(nil)
    check(history.moveIn(focusedOn: nil, selected: nil) == payables && history.steppedOutOf == column,
          "the first fn+Right goes back into the file, on the column the first fn+Left left")
    history.noteFocus(payables)
    history.moveIn(focusedOn: payables, selected: nil, highlighted: column)
    check(focusId(history.requestFields) == "invoice-date", "the second goes back into the column")

    // A value tabbed from every directory has nothing below it to go back into.
    var leaf = LinkedSourceMemory()
    _ = accept(&leaf, source("width", "100 mm"), after: "It is ")
    leaf.noteFocus(nil)
    check(leaf.recent == nil && !leaf.canMoveIn(focusedOn: nil, selected: nil),
          "a value tabbed from every directory is no way back for fn+Right")

    // After a move the card stays on screen even with nothing to offer, so the move can be undone.
    var moving = LinkedSourceMemory()
    _ = accept(&moving, bracket, after: "The ")
    moving.observe("The Bracket is", reachesStart: true)
    check(!moving.keepsEmptyCard(focusedOn: bracket), "an empty answer to typing closes the card")
    moving.moveOut(from: bracket)
    check(moving.keepsEmptyCard(focusedOn: nil), "after fn+Left an empty card stays, so fn+Right can come back")
    moving.endMove()
    check(!moving.keepsEmptyCard(focusedOn: nil), "typing on closes an empty card again")
    moving.moveIn(focusedOn: nil, selected: nil)
    check(moving.keepsEmptyCard(focusedOn: bracket), "after fn+Right an empty card stays, so fn+Left can go back")
    var fresh = LinkedSourceMemory()
    fresh.moveOut(from: nil)
    check(!fresh.keepsEmptyCard(focusedOn: nil), "with nowhere to move back, an empty card closes")
}

print("fn+Left steps the card back one level at a time")
do {
    func source(_ id: String, _ text: String, project: String = "cad") -> LinkedSourceMemory.Source {
        LinkedSourceMemory.Source(projectId: project, objectId: id, snapshotId: "snap-\(id)", text: text)
    }
    func focusId(_ fields: [String: Any]) -> String? {
        (fields["focusSource"] as? [String: Any])?["sourceObjectId"] as? String
    }
    func pendingIds(_ fields: [String: Any]) -> [String] {
        (fields["pendingDependencies"] as? [[String: Any]] ?? []).compactMap { $0["sourceObjectId"] as? String }
    }
    func accept(_ memory: inout LinkedSourceMemory, _ accepted: LinkedSourceMemory.Source, after before: String) -> String {
        let units = Array((before + accepted.text).utf16)
        memory.record(accepted, in: units, at: (units.count - accepted.text.utf16.count)..<units.count)
        return before + accepted.text
    }
    let bracket = source("bracket", "Bracket"), width = source("width", "Bracket overall X extent")

    // "the bra", Tab, then fn+Right on 100 mm: fn+Left brings the part's list back.
    var memory = LinkedSourceMemory()
    memory.noteFocus(nil)
    let text = accept(&memory, bracket, after: "the ")
    memory.observe(text, reachesStart: true)
    memory.noteFocus(bracket)
    check(memory.stepBack == nil, "the card Tab focused steps back to every directory")
    memory.moveIn(focusedOn: bracket, selected: width)
    memory.noteFocus(width)
    check(focusId(memory.requestFields) == "width" && memory.stepBack == bracket,
          "fn+Right narrows to the measurement, one level below the part")
    memory.moveOut(from: width)
    check(focusId(memory.requestFields) == nil && pendingIds(memory.requestFields) == ["bracket"],
          "fn+Left asks for the part's values again, not every directory")
    memory.noteFocus(bracket)
    check(memory.canMoveIn(focusedOn: bracket, selected: width),
          "back on the part's list, fn+Right can narrow to the measurement again")
    memory.moveOut(from: bracket)
    check(memory.requestFields.isEmpty, "a second fn+Left reaches every directory")
    memory.noteFocus(nil)
    check(memory.recent == bracket && memory.keepsEmptyCard(focusedOn: nil),
          "from every directory fn+Right returns to the part, the level fn+Left just left")
    memory.moveIn(focusedOn: nil, selected: nil)
    memory.noteFocus(bracket)
    memory.moveIn(focusedOn: bracket, selected: width)
    memory.noteFocus(width)
    memory.moveOut(from: width)
    check(focusId(memory.requestFields) == nil && pendingIds(memory.requestFields) == ["bracket"],
          "each fn+Right is undone by one fn+Left")
    memory.noteFocus(bracket)
    memory.moveOut(from: bracket)
    check(memory.requestFields.isEmpty && memory.stepBack == nil, "and the last one returns to every directory")

    // Sources accepted one inside another step back the way deleting them would.
    let file = source("payables", "Accounts-Payable", project: "accounts")
    let column = source("invoice-date", "Invoice Date", project: "accounts")
    var chain = LinkedSourceMemory()
    var sentence = accept(&chain, file, after: "")
    chain.observe(sentence + " inv", reachesStart: true)
    chain.noteFocus(nil)
    sentence = accept(&chain, column, after: sentence + " ")
    chain.observe(sentence + " ", reachesStart: true)
    chain.noteFocus(column)
    check(chain.stepBack == nil, "a source tabbed on a card from every directory steps back to it")
    chain.moveOut(from: column)
    check(pendingIds(chain.requestFields) == ["payables"],
          "fn+Left on a tabbed column steps back to the file it was named in, which stays in the text")
    chain.observe(String(sentence.dropLast()), reachesStart: true)
    check(pendingIds(chain.requestFields) == ["payables"], "deleting the column afterwards changes nothing more")

    var nested = LinkedSourceMemory()
    let row = source("city-row", "City Office Consumables", project: "accounts")
    let cell = source("city-amount", "City Office Consumables · Amount", project: "accounts")
    _ = accept(&nested, column, after: "")
    nested.noteFocus(column)
    nested.moveIn(focusedOn: column, selected: row)
    nested.noteFocus(row)
    nested.moveIn(focusedOn: row, selected: cell)
    nested.noteFocus(cell)
    check(nested.stepBack == row, "a row narrowed twice steps back to the row first")
    nested.moveOut(from: cell)
    check(focusId(nested.requestFields) == "city-row", "then to the row")
    nested.noteFocus(row)
    check(nested.stepBack == column, "and names the column next")
    nested.moveOut(from: row)
    check(focusId(nested.requestFields) == nil && pendingIds(nested.requestFields) == ["invoice-date"],
          "then to the column accepted with Tab")

    // Tab on a narrowed card: fn+Left out of that Tab returns to the narrowed focus, as deleting it would.
    var replacing = LinkedSourceMemory()
    let header = source("header-row", "Vendor", project: "accounts")
    var written = accept(&replacing, column, after: "")
    replacing.noteFocus(column)
    replacing.moveIn(focusedOn: column, selected: row)
    replacing.noteFocus(row)
    written = accept(&replacing, header, after: written + " ")
    replacing.observe(written + " ", reachesStart: true)
    replacing.noteFocus(header)
    check(replacing.stepBack == row, "the header of a source tabbed on a narrowed card names that focus")
    replacing.moveOut(from: header)
    check(focusId(replacing.requestFields) == "city-row", "and fn+Left goes there, not to the source beneath it")

    // fn+Left and fn+Right still move after deleting a value accepted with Tab.
    var deleted = LinkedSourceMemory()
    let value = source("x-extent-value", "100 mm")
    var typed = accept(&deleted, bracket, after: "the ")
    deleted.noteFocus(bracket)
    typed = accept(&deleted, value, after: typed + " is ")
    deleted.noteFocus(nil)
    deleted.observe(String(typed.dropLast(2)), reachesStart: true)
    deleted.noteFocus(bracket)
    check(pendingIds(deleted.requestFields) == ["bracket"], "deleting the value shows the part's list again")
    deleted.moveIn(focusedOn: bracket, selected: width)
    check(focusId(deleted.requestFields) == "width", "fn+Right then narrows it")
    deleted.noteFocus(width)
    deleted.moveOut(from: width)
    deleted.noteFocus(bracket)
    deleted.moveOut(from: bracket)
    check(deleted.requestFields.isEmpty, "and fn+Left steps back to every directory")

    // A removed directory takes the fn+Left out of its source along.
    var removing = LinkedSourceMemory()
    let quote = source("quote", "Quote 114", project: "finance")
    let both = accept(&removing, bracket, after: "the ")
    _ = accept(&removing, quote, after: both + " and ")
    removing.moveOut(from: quote)
    removing.keep(projectIds: ["cad"])
    check(pendingIds(removing.requestFields) == ["bracket"],
          "fn+Left out of a source in a removed directory does not step back out of the one before it")

    let rows: [String?] = ["height", nil, "width"]
    check(FocusLanding.row(objectId: "width").index(in: rows) == 2,
          "the list fn+Left returns to opens on the row it stepped out of")
    check(FocusLanding.row(objectId: "gone").index(in: rows) == 0 && FocusLanding.first.index(in: rows) == 0,
          "a list without that row, or one fn+Right narrowed to, opens at the top")
}

print("deleting text accepted with Tab steps the card's focus back")
do {
    func source(_ id: String, _ text: String, project: String = "cad") -> LinkedSourceMemory.Source {
        LinkedSourceMemory.Source(projectId: project, objectId: id, snapshotId: "snap-\(id)", text: text)
    }
    func focusId(_ fields: [String: Any]) -> String? {
        (fields["focusSource"] as? [String: Any])?["sourceObjectId"] as? String
    }
    func pendingIds(_ fields: [String: Any]) -> [String] {
        (fields["pendingDependencies"] as? [[String: Any]] ?? []).compactMap { $0["sourceObjectId"] as? String }
    }
    func accept(_ memory: inout LinkedSourceMemory, _ accepted: LinkedSourceMemory.Source, after before: String) -> String {
        let units = Array((before + accepted.text).utf16)
        memory.record(accepted, in: units, at: (units.count - accepted.text.utf16.count)..<units.count)
        return before + accepted.text
    }
    let file = source("payables", "Accounts-Payable.csv", project: "accounts")
    let column = source("invoice-date", "Invoice Date", project: "accounts")
    let date = source("city-date", "2026-09-30", project: "accounts")
    let row = source("city-row", "City Office Consumables", project: "accounts")

    var memory = LinkedSourceMemory()
    var text = accept(&memory, file, after: "")
    text = accept(&memory, column, after: text + " ")
    text = accept(&memory, date, after: text + " is ")
    memory.observe(text, reachesStart: true)
    check(pendingIds(memory.requestFields) == ["payables", "invoice-date", "city-date"], "each accepted source is sent")
    memory.observe(String(text.dropLast()), reachesStart: true)
    check(pendingIds(memory.requestFields) == ["payables", "invoice-date"],
          "deleting into the value accepted last steps back to the column before it")
    memory.observe("Accounts-Payable.csv Invoice Da", reachesStart: true)
    check(pendingIds(memory.requestFields) == ["payables"], "deleting the column steps back to the file")
    memory.observe("Accounts-Payable.cs", reachesStart: true)
    check(memory.requestFields.isEmpty && !memory.canMoveIn(focusedOn: nil, selected: nil),
          "deleting the text that first narrowed the card returns it to every directory")
    memory.observe(text, reachesStart: true)
    check(pendingIds(memory.requestFields) == ["payables", "invoice-date", "city-date"],
          "text that comes back, such as after Undo, is focused again")

    // A focus chosen with fn+Right rests on the accepted text it was chosen from.
    var narrowed = LinkedSourceMemory()
    var sentence = accept(&narrowed, file, after: "")
    narrowed.observe(sentence + " ", reachesStart: true)
    narrowed.moveIn(focusedOn: file, selected: row)
    sentence = accept(&narrowed, date, after: sentence + " shows ")
    narrowed.observe(sentence, reachesStart: true)
    check(focusId(narrowed.requestFields) == nil && pendingIds(narrowed.requestFields) == ["payables", "city-date"],
          "Tab ends the focus chosen with fn+Right")
    narrowed.observe("Accounts-Payable.csv shows 2026-", reachesStart: true)
    check(focusId(narrowed.requestFields) == "city-row",
          "deleting the value accepted last returns to the row fn+Right had chosen before it")
    narrowed.observe("Accounts-Payable", reachesStart: true)
    check(narrowed.requestFields.isEmpty, "deleting the file it was chosen on returns to every directory")

    var returned = LinkedSourceMemory()
    let named = accept(&returned, file, after: "See ")
    returned.observe(named + " for", reachesStart: true)
    returned.moveOut(from: file)
    returned.moveIn(focusedOn: nil, selected: nil)
    check(pendingIds(returned.requestFields) == ["payables"], "fn+Left then fn+Right focuses the file again")
    returned.observe("See ", reachesStart: true)
    check(returned.requestFields.isEmpty && !returned.canMoveIn(focusedOn: nil, selected: nil),
          "deleting the file's name ends a focus fn+Right returned to, and fn+Right's way back to it")

    // A long paragraph moves the accepted text out of the window sent from the
    // host; that is not a deletion, so a chosen focus holds.
    var long = LinkedSourceMemory()
    _ = accept(&long, file, after: "In ")
    long.observe("In Accounts-Payable.csv the", reachesStart: true)
    long.moveIn(focusedOn: file, selected: row)
    long.observe(" supplier was paid late, and the next words are all that the window still holds", reachesStart: false)
    check(focusId(long.requestFields) == "city-row", "accepted text scrolled out of the window is not deleted")
    long.observe("In the", reachesStart: true)
    check(long.requestFields.isEmpty, "a window from the start of the field without it is a deletion")
}

print("Lasso never reads its own windows through Accessibility")
do {
    check(!AccessibilityWork.mayRead(pid: 4242, own: 4242),
          "the queue does not read Lasso itself, whose reads macOS would answer off the main thread")
    check(!AccessibilityWork.mayRead(pid: ProcessInfo.processInfo.processIdentifier),
          "this process counts as Lasso when nothing else is said")
    check(AccessibilityWork.mayRead(pid: 911, own: 4242) && !AccessibilityWork.mayRead(pid: 0, own: 4242),
          "another app is read, and a missing app is not")
}

print("slow hosts cost one outstanding Accessibility read")
do {
    var gate = CoalescingGate()
    check(gate.begin(), "the first read starts")
    check(!gate.begin() && !gate.begin() && !gate.begin(), "reads requested while one runs wait")
    check(gate.end(), "a single follow-up runs after the slow read, however many were requested")
    check(gate.begin() && !gate.end(), "the follow-up leaves nothing pending")
    check(gate.begin(), "an idle gate starts the next read")
    _ = gate.end()
    _ = gate.begin()
    _ = gate.begin()
    gate.dropPending()
    check(!gate.end(), "dismissing the box drops a follow-up that would reopen it")
}

print("a list the writer types past without a new answer closes")
do {
    var typing = UnansweredTyping(limit: 0.5)
    let start = Date(timeIntervalSinceReferenceDate: 1000)
    check(typing.typed(at: start) == start.addingTimeInterval(0.5), "the first key over a list starts the wait")
    check(typing.typed(at: start.addingTimeInterval(0.3)) == nil, "later keys do not put the close off")
    typing.answered()
    check(typing.typed(at: start.addingTimeInterval(2)) == start.addingTimeInterval(2.5),
          "an answer for the newer text starts the wait over")
}

print("accepting a suggestion reads and writes the host off the main thread")
do {
    // The main thread waits on a semaphore throughout, so any step that
    // still needed it would time out here.
    let onAccessibilityQueue = DispatchSpecificKey<Bool>()
    AccessibilityWork.queue.setSpecific(key: onAccessibilityQueue, value: true)
    defer { AccessibilityWork.queue.setSpecific(key: onAccessibilityQueue, value: nil) }
    func onQueue() -> Bool { DispatchQueue.getSpecific(key: onAccessibilityQueue) == true }
    let finished = DispatchSemaphore(value: 0)
    func waited() -> Bool { finished.wait(timeout: .now() + 2) == .success }

    var attempts = 0
    var everyAttemptOnQueue = true
    var verified: Bool?
    var reportedOnQueue = false
    AccessibilityWork.queue.async {
        RichTextInserter.verifyEventually(attempts: 4, interval: 0.01, verify: {
            attempts += 1
            everyAttemptOnQueue = everyAttemptOnQueue && onQueue()
            return attempts == 3
        }) { result in
            verified = result
            reportedOnQueue = onQueue()
            finished.signal()
        }
    }
    check(waited() && verified == true && attempts == 3, "read-back retries until the link appears, then stops")
    check(everyAttemptOnQueue && reportedOnQueue, "each read-back and its result stay on the Accessibility queue")

    attempts = 0
    verified = nil
    AccessibilityWork.queue.async {
        RichTextInserter.verifyEventually(attempts: 3, interval: 0.01, verify: {
            attempts += 1
            return false
        }) { result in
            verified = result
            finished.signal()
        }
    }
    check(waited() && verified == false && attempts == 3,
          "a link that never shows up is reported once, after the last read-back")

    // Refused before anything is pasted, so this never types into the app
    // that has focus while the tests run.
    var validations: [Bool] = []
    var pasted: Bool?
    reportedOnQueue = false
    let clipboard = NSPasteboard.general.changeCount
    AccessibilityWork.queue.async {
        RichTextInserter.insertLink(label: "Office supplies", url: URL(string: "http://127.0.0.1:4319/s/abc")!,
                                    replacing: 0, at: -1, in: AXUIElementCreateApplication(getpid()),
                                    keyboardDeleteCount: 0, validateSelection: { _ in
            validations.append(onQueue())
            return false
        }) { result in
            pasted = result
            reportedOnQueue = onQueue()
            finished.signal()
        }
    }
    check(waited() && pasted == false && NSPasteboard.general.changeCount == clipboard,
          "an insertion point that cannot be confirmed pastes nothing and leaves the clipboard alone")
    check(validations == [true] && reportedOnQueue,
          "the insertion point is checked, and the refusal reported, on the Accessibility queue")
}

print("focused text element")
do {
    // A tree shaped like Word 16.114's: the pane reports focus, and the text
    // area holding the caret sits several groups below it.
    struct Node { let name: String; let focusedText: Bool; let children: [Node] }
    func leaf(_ name: String, focusedText: Bool = false) -> Node { Node(name: name, focusedText: focusedText, children: []) }
    func group(_ name: String, _ children: [Node]) -> Node { Node(name: name, focusedText: false, children: children) }
    func search(_ root: Node, visits: Int = FocusedTextElement.maxVisits) -> String? {
        FocusedTextElement.search(from: root, children: { $0.children }, isFocusedText: { $0.focusedText },
                                  maxVisits: visits)?.name
    }

    let word = group("split", [group("group", [group("scroll", [
        leaf("scroll bar"),
        group("layout", [group("page", [group("body", [leaf("text", focusedText: true)])])]),
    ])])])
    check(search(word) == "text", "a focused text area below a focused pane is found")
    check(search(group("split", [leaf("button"), leaf("label")])) == nil,
          "a pane with no focused text below it finds nothing")
    check(search(leaf("field", focusedText: true)) == "field", "an element that is itself the text is kept")
    check(search(word, visits: 3) == nil, "the search stops after its visit budget")
}

print("popup host window")
do {
    // Chrome in full screen, as read on macOS 26: the address bar names the
    // group holding the toolbar overlay as its window, and the browser window
    // sits above that group.
    final class Node {
        let role: String; let parent: Node?
        init(_ role: String, parent: Node?) { self.role = role; self.parent = parent }
    }
    func owner(of editor: Node, named reported: Node?, maxDepth: Int = AssistPopupHost.maxWindowDepth) -> Node? {
        AssistPopupHost.owningWindow(named: reported, above: editor, parent: { $0.parent }, role: { $0.role },
                                     maxDepth: maxDepth)
    }
    let application = Node("AXApplication", parent: nil)
    let browser = Node("AXWindow", parent: application)
    let overlay = Node("AXGroup", parent: browser)
    var toolbar = overlay
    for role in ["AXGroup", "AXGroup", "AXGroup", "AXToolbar", "AXGroup"] { toolbar = Node(role, parent: toolbar) }
    let addressBar = Node("AXTextField", parent: toolbar)
    check(owner(of: addressBar, named: overlay) === browser,
          "an address bar in Chrome's full-screen overlay belongs to the browser window above it")

    let window = Node("AXWindow", parent: application)
    let field = Node("AXTextField", parent: Node("AXGroup", parent: window))
    check(owner(of: field, named: window) === window, "an editor that names its window keeps it")
    check(owner(of: field, named: Node("AXGroup", parent: nil)) === window,
          "a named container that is not a window gives way to the window above the editor")
    check(owner(of: field, named: nil) === window,
          "an editor that reports no window attribute still finds the window above it")
    let loose = Node("AXTextField", parent: Node("AXGroup", parent: application))
    check(owner(of: loose, named: Node("AXGroup", parent: nil)) == nil, "an editor with no window above it has none")
    check(owner(of: addressBar, named: overlay, maxDepth: 3) == nil, "the walk up stops after its depth budget")
}

print("host accessibility mode")
do {
    check(!HostAccessibilityMode.needsEnhancedInterface(manualAccepted: true, chromiumBased: true),
          "an app that accepts AXManualAccessibility never gets the enhanced flag")
    check(HostAccessibilityMode.needsEnhancedInterface(manualAccepted: false, chromiumBased: true),
          "a Chromium build that ignores AXManualAccessibility keeps the enhanced flag")
    check(!HostAccessibilityMode.needsEnhancedInterface(manualAccepted: false, chromiumBased: false),
          "native apps get neither flag")

    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("lasso-chromium-\(UUID().uuidString)", isDirectory: true)
    func bundle(_ name: String, framework: String, resource: String, versioned: Bool = false) -> URL {
        let app = root.appendingPathComponent(name + ".app", isDirectory: true)
        let frameworkURL = app.appendingPathComponent("Contents/Frameworks/\(framework).framework", isDirectory: true)
        let resources = versioned
            ? frameworkURL.appendingPathComponent("Versions/A/Resources", isDirectory: true)
            : frameworkURL.appendingPathComponent("Resources", isDirectory: true)
        try? FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: resources.appendingPathComponent(resource).path, contents: Data())
        return app
    }
    let browser = bundle("Browser", framework: "Browser Framework", resource: "chrome_100_percent.pak")
    let versioned = bundle("Versioned", framework: "Versioned Framework", resource: "chrome_100_percent.pak",
                           versioned: true)
    let numbered = root.appendingPathComponent("Numbered.app", isDirectory: true)
    let numberedResources = numbered.appendingPathComponent(
        "Contents/Frameworks/Google Chrome Framework.framework/Versions/157.0.8103.79/Resources", isDirectory: true)
    try? FileManager.default.createDirectory(at: numberedResources, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: numberedResources.appendingPathComponent("chrome_100_percent.pak").path, contents: Data())
    let native = bundle("Native", framework: "Sparkle", resource: "Info.plist")
    check(HostAccessibilityMode.isChromiumBased(bundleURL: browser), "detects a Chromium framework bundle")
    check(HostAccessibilityMode.isChromiumBased(bundleURL: versioned), "detects a versioned framework layout")
    check(HostAccessibilityMode.isChromiumBased(bundleURL: numbered), "detects a numbered Chromium version layout without a Current symlink")
    check(!HostAccessibilityMode.isChromiumBased(bundleURL: native), "a native app is not Chromium")
    check(!HostAccessibilityMode.isChromiumBased(bundleURL: nil), "an app without a bundle is not Chromium")
    check(HostAccessibilityMode.isChromiumBundle(bundleURL: nil, bundleIdentifier: "com.google.Chrome.app.abc"),
          "recognizes Chrome web app shims as Chromium")
    try? FileManager.default.removeItem(at: root)

    var writes: [(pid: pid_t, attribute: String, value: Bool)] = []
    var manualResult = AXError.attributeUnsupported
    var enhancedAlreadyOn = false
    var chromium: Set<pid_t> = []
    let suite = "lasso-tests-accessibility-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    func makeMode() -> HostAccessibilityMode {
        HostAccessibilityMode(
            setFlag: { element, attribute, value in
                var pid: pid_t = 0
                AXUIElementGetPid(element, &pid)
                writes.append((pid, attribute, value))
                return attribute == HostAccessibilityMode.manualAttribute ? manualResult : .success
            },
            readFlag: { _, _ in enhancedAlreadyOn },
            chromiumBased: { chromium.contains($0) },
            bundleIdentifier: { "com.example.app\($0)" },
            defaults: defaults)
    }
    let mode = makeMode()
    func enhancedWrites(_ pid: pid_t, _ value: Bool) -> Int {
        writes.filter { $0.pid == pid && $0.attribute == HostAccessibilityMode.enhancedAttribute && $0.value == value }.count
    }

    _ = mode.prime(pid: 101, application: AXUIElementCreateApplication(101))
    check(writes.count == 1 && writes[0].attribute == HostAccessibilityMode.manualAttribute,
          "a native app is only asked for AXManualAccessibility")
    check(mode.prime(pid: 101, application: AXUIElementCreateApplication(101)) == nil && writes.count == 1,
          "an app is primed once")

    manualResult = .success
    chromium = [202, 303, 404]
    _ = mode.prime(pid: 202, application: AXUIElementCreateApplication(202))
    check(enhancedWrites(202, true) == 0, "an Electron app that accepts the manual flag is left alone")

    manualResult = .attributeUnsupported
    _ = mode.prime(pid: 303, application: AXUIElementCreateApplication(303))
    check(enhancedWrites(303, true) == 1, "Chromium that needs it gets AXEnhancedUserInterface")
    enhancedAlreadyOn = true
    _ = mode.prime(pid: 404, application: AXUIElementCreateApplication(404))
    check(enhancedWrites(404, true) == 0, "an enhanced flag set by VoiceOver or another tool is not taken over")

    check(mode.restoreAll() == 1 && enhancedWrites(303, false) == 1 && enhancedWrites(404, false) == 0,
          "turning suggestions off reverts only the flag Lasso set")
    check(mode.restoreAll() == 0 && enhancedWrites(303, false) == 1, "reverting twice writes nothing more")
    enhancedAlreadyOn = false
    _ = mode.prime(pid: 303, application: AXUIElementCreateApplication(303))
    check(enhancedWrites(303, true) == 2, "the next enable primes the app again")
    mode.forget(pid: 303)
    check(mode.restoreAll() == 0, "a quit app is not written to")

    // Lasso quits or crashes before it can turn the flag off again.
    enhancedAlreadyOn = false
    chromium = [505]
    _ = makeMode().prime(pid: 505, application: AXUIElementCreateApplication(505))
    enhancedAlreadyOn = true
    let relaunched = makeMode()
    _ = relaunched.prime(pid: 505, application: AXUIElementCreateApplication(505))
    check(relaunched.restoreAll() == 1 && enhancedWrites(505, false) == 1,
          "a flag a previous run of Lasso set and never reverted is still Lasso's to revert")
    _ = makeMode().prime(pid: 505, application: AXUIElementCreateApplication(505))
    check(makeMode().restoreAll() == 0, "once reverted, a flag found on again belongs to someone else")

    // Transient failure, external turn-off, and no-op AXManualAccessibility recovery in Chrome.
    var clock = Date(timeIntervalSince1970: 1_000)
    var enhancedResult = AXError.cannotComplete
    var manualReadBack = false
    var enhancedOn = false
    var electronPids: Set<pid_t> = []
    var recoveryWrites: [(pid: pid_t, attribute: String, value: Bool)] = []
    let recovery = HostAccessibilityMode(
        setFlag: { element, attribute, value in
            var pid: pid_t = 0
            AXUIElementGetPid(element, &pid)
            recoveryWrites.append((pid, attribute, value))
            if attribute == HostAccessibilityMode.manualAttribute { return manualResult }
            if enhancedResult == .success { enhancedOn = value }
            return enhancedResult
        },
        readFlag: { _, attribute in
            attribute == HostAccessibilityMode.manualAttribute ? manualReadBack : enhancedOn
        },
        chromiumBased: { [606, 707, 808].contains($0) },
        electronBased: { electronPids.contains($0) },
        bundleIdentifier: { $0 == 606 ? "com.google.Chrome" : "com.example.app\($0)" },
        defaults: defaults,
        now: { clock })
    manualResult = .attributeUnsupported
    _ = recovery.prime(pid: 606, application: AXUIElementCreateApplication(606))
    check(!enhancedOn, "a transient enhanced write failure leaves Chrome unprimed")
    enhancedResult = .success
    _ = recovery.prime(pid: 606, application: AXUIElementCreateApplication(606))
    check(enhancedOn, "the next attempt retries and enables AXEnhancedUserInterface on Chrome")
    enhancedOn = false
    check(recovery.reprimeIfUnreadable(pid: 606, application: AXUIElementCreateApplication(606)) && enhancedOn,
          "an unreadable Chrome window re-enables AXEnhancedUserInterface when it was turned off externally")
    enhancedOn = false
    check(!recovery.reprimeIfUnreadable(pid: 606, application: AXUIElementCreateApplication(606)) && !enhancedOn,
          "re-priming is throttled within its cooldown")
    clock = clock.addingTimeInterval(3)
    check(recovery.reprimeIfUnreadable(pid: 606, application: AXUIElementCreateApplication(606)) && enhancedOn,
          "after the cooldown an unreadable Chrome window re-enables accessibility again")

    // A non-Electron browser that accepts AXManualAccessibility without keeping it falls back when unreadable.
    manualResult = .success
    manualReadBack = false
    enhancedOn = false
    _ = recovery.prime(pid: 707, application: AXUIElementCreateApplication(707))
    check(!enhancedOn, "initial prime trusts AXManualAccessibility without enabling enhanced mode")
    clock = clock.addingTimeInterval(3)
    check(recovery.reprimeIfUnreadable(pid: 707, application: AXUIElementCreateApplication(707)) && enhancedOn,
          "a non-Electron browser whose AXManualAccessibility did not hold falls back to AXEnhancedUserInterface when unreadable")

    // Electron apps keep using AXManualAccessibility and never get AXEnhancedUserInterface.
    electronPids = [808]
    enhancedOn = false
    _ = recovery.prime(pid: 808, application: AXUIElementCreateApplication(808))
    clock = clock.addingTimeInterval(3)
    let before808 = recoveryWrites.filter { $0.pid == 808 && $0.attribute == HostAccessibilityMode.manualAttribute }.count
    _ = recovery.reprimeIfUnreadable(pid: 808, application: AXUIElementCreateApplication(808))
    let after808 = recoveryWrites.filter { $0.pid == 808 && $0.attribute == HostAccessibilityMode.manualAttribute }.count
    check(after808 == before808 + 1 && !enhancedOn,
          "an unreadable Electron app re-sends AXManualAccessibility without touching AXEnhancedUserInterface")

    defaults.removePersistentDomain(forName: suite)
}

print("highlight geometry is reused while text, frame and caret are unchanged")
do {
    let element = AXUIElementCreateApplication(getpid())
    let frame = CGRect(x: 100, y: 200, width: 400, height: 300)
    let window = CGRect(x: 80, y: 120, width: 600, height: 500)
    let caret = CGRect(x: 180, y: 220, width: 1, height: 16)
    func snapshot(text: String = "Office supplies cost $400", element: AXUIElement = element,
                  frame: CGRect? = frame, caret: CGRect? = caret) -> HighlightGeometrySnapshot {
        HighlightGeometrySnapshot(element: element, text: text, elementFrame: frame, windowFrame: window, caret: caret)
    }
    var cache = HighlightGeometryCache()
    var measured = 0
    func measure(_ range: Range<Int>) -> [CGRect] {
        measured += 1
        return [CGRect(x: CGFloat(100 + range.lowerBound * 7), y: 220, width: CGFloat(range.count * 7), height: 16)]
    }
    let first = cache.rects(for: 0..<6, in: snapshot(), measure: measure)
    let again = cache.rects(for: 0..<6, in: snapshot(), measure: measure)
    check(measured == 1 && first == again, "an unchanged layout is measured once")
    _ = cache.rects(for: 7..<15, in: snapshot(), measure: measure)
    check(measured == 2, "each reference is measured once per layout")
    _ = cache.rects(for: 0..<6, in: snapshot(caret: caret.offsetBy(dx: 0, dy: -40)), measure: measure)
    check(measured == 3, "a moved caret (scrolling) measures again")
    _ = cache.rects(for: 0..<6, in: snapshot(text: "Office supplies cost $450"), measure: measure)
    check(measured == 4, "an edit measures again")
    _ = cache.rects(for: 0..<6, in: snapshot(frame: frame.offsetBy(dx: 20, dy: 0)), measure: measure)
    check(measured == 5, "a moved or resized editor measures again")
    _ = cache.rects(for: 0..<6, in: snapshot(element: AXUIElementCreateApplication(1)), measure: measure)
    check(measured == 6, "another editor measures again")
    _ = cache.rects(for: 0..<6, in: snapshot(caret: nil), measure: measure)
    _ = cache.rects(for: 0..<6, in: snapshot(caret: nil), measure: measure)
    check(measured == 8, "without a caret to detect scrolling nothing is reused")
    var failing = 0
    _ = cache.rects(for: 2..<4, in: snapshot()) { _ in failing += 1; return [] }
    _ = cache.rects(for: 2..<4, in: snapshot()) { _ in failing += 1; return [] }
    check(failing == 2, "missing geometry is retried rather than remembered")
    var slow = 0
    let slowFirst = cache.rects(for: 9..<14, in: snapshot()) { _ in slow += 1; return nil }
    let slowSecond = cache.rects(for: 9..<14, in: snapshot()) { _ in slow += 1; return nil }
    check(slow == 1 && slowFirst.isEmpty && slowSecond.isEmpty,
          "a phrase too slow to measure is not walked again for the same layout")
    _ = cache.rects(for: 9..<14, in: snapshot(caret: caret.offsetBy(dx: 7, dy: 0))) { _ in slow += 1; return nil }
    check(slow == 2, "a new layout tries the slow phrase again")
}


// ── Main menu ──────────────────────────────────────────────────────────────
// A menu bar app still needs the standard menus: AppKit routes Command-key
// shortcuts through them, so without one Copy and Paste do nothing.
do {
    print("\nMain menu")
    final class MenuTarget: NSObject {
        @objc func about() {}
        @objc func settings() {}
        @objc func add() {}
        @objc func ranch() {}
        @objc func help() {}
    }
    let menuTarget = MenuTarget()
    _ = NSApplication.shared
    MainMenu.install(MainMenu.Commands(target: menuTarget, about: #selector(MenuTarget.about),
        settings: #selector(MenuTarget.settings), addDirectories: #selector(MenuTarget.add),
        openRanch: #selector(MenuTarget.ranch), help: #selector(MenuTarget.help)))
    let bar = NSApp.mainMenu
    check(bar?.items.map(\.title) == ["Lasso", "File", "Edit", "View", "Window", "Help"],
          "menu bar lists Lasso, File, Edit, View, Window and Help in order")
    func shortcut(_ menu: String, _ key: String, _ modifiers: NSEvent.ModifierFlags = .command) -> NSMenuItem? {
        func search(_ items: [NSMenuItem]) -> NSMenuItem? {
            for item in items {
                if item.keyEquivalent == key && item.keyEquivalentModifierMask == modifiers { return item }
                if let found = item.submenu.flatMap({ search($0.items) }) { return found }
            }
            return nil
        }
        return bar?.items.first { $0.title == menu }?.submenu.flatMap { search($0.items) }
    }
    check(shortcut("Lasso", ",")?.action == #selector(MenuTarget.settings) && shortcut("Lasso", ",")?.title == "Settings…",
          "Command-Comma opens Settings…")
    check(shortcut("Lasso", "q")?.action == #selector(NSApplication.terminate(_:)), "Command-Q quits")
    check(shortcut("Lasso", "h")?.action == #selector(NSApplication.hide(_:)), "Command-H hides Lasso")
    check(shortcut("File", "w")?.action == #selector(NSWindow.performClose(_:)), "Command-W closes the window")
    check(shortcut("Edit", "c")?.action == #selector(NSText.copy(_:))
          && shortcut("Edit", "v")?.action == #selector(NSText.paste(_:))
          && shortcut("Edit", "x")?.action == #selector(NSText.cut(_:))
          && shortcut("Edit", "a")?.action == #selector(NSText.selectAll(_:)),
          "Cut, Copy, Paste and Select All use their standard shortcuts")
    check(shortcut("Edit", "z")?.action == Selector(("undo:")) && shortcut("Edit", "z", [.command, .shift])?.action == Selector(("redo:")),
          "Undo and Redo use Command-Z and Shift-Command-Z")
    check(shortcut("Edit", "f")?.tag == Int(NSFindPanelAction.showFindPanel.rawValue), "Command-F opens Find")
    check(shortcut("Window", "m")?.action == #selector(NSWindow.performMiniaturize(_:)), "Command-M minimizes")
    check(shortcut("Help", "?")?.action == #selector(MenuTarget.help), "Command-? opens Lasso Help")
    let ranch = shortcut("File", "r", [.command, .shift])
    check(ranch?.action == #selector(MenuTarget.ranch) && ranch?.title == "Open The Ranch" && ranch?.isHidden == false,
          "Shift-Command-R opens The Ranch, as the key held in every app")
    let ranchAlias = shortcut("File", "r")
    check(ranchAlias?.action == #selector(MenuTarget.ranch) && ranchAlias?.isHidden == true
          && ranchAlias?.allowsKeyEquivalentWhenHidden == true,
          "plain Command-R still opens The Ranch inside Lasso, without a second menu row")
    check(!(bar?.items ?? []).flatMap({ $0.submenu?.items ?? [] }).contains { $0.title.localizedCaseInsensitiveContains("browser") },
          "nothing in the menu bar sends you to the browser")
    check(NSApp.windowsMenu?.title == "Window" && NSApp.helpMenu?.title == "Help",
          "Window and Help menus are registered with AppKit")
    let titles = (bar?.items ?? []).flatMap { $0.submenu?.items ?? [] }.map(\.title).filter { !$0.isEmpty }
    check(titles.allSatisfy { !$0.contains("\u{2014}") }, "menu titles contain no em dashes")
}


// ── Settings ───────────────────────────────────────────────────────────────
// Settings holds what the status panel does not: appearance, the colour of
// folders, and how Lasso starts again after it quits.
do {
    print("\nSettings")
    _ = NSApplication.shared
    let defaults = MemoryDirectoryDefaults(suiteName: nil)!
    check(AppearancePreference.current(defaults) == .system && NSApp.appearance == nil,
          "Lasso follows macOS until an appearance is chosen")
    AppearancePreference.set(.dark, defaults: defaults)
    check(AppearancePreference.current(defaults) == .dark && NSApp.appearance?.name == .darkAqua,
          "choosing Dark turns Lasso's windows dark at once")
    AppearancePreference.set(.light, defaults: defaults)
    check(NSApp.appearance?.name == .aqua, "choosing Light turns them light")
    AppearancePreference.set(.system, defaults: defaults)
    check(NSApp.appearance == nil, "Match System hands the appearance back to macOS")
    check(AppearancePreference.allCases.map(\.title) == ["Match System", "Light", "Dark"],
          "the appearance choices read Match System, Light and Dark")

    check(DirectoryColorPreferences.defaultColor(defaults) == .blue, "folders are blue until another colour is chosen")
    DirectoryColorPreferences.set(.orange, for: "finance", defaults: defaults)
    var announced = 0
    let observer = NotificationCenter.default.addObserver(forName: .directoryColorsDidChange, object: nil,
                                                          queue: nil) { _ in announced += 1 }
    DirectoryColorPreferences.setDefault(.purple, defaults: defaults)
    DirectoryColorPreferences.setDefault(.purple, defaults: defaults)
    NotificationCenter.default.removeObserver(observer)
    check(DirectoryColorPreferences.color(for: "research", defaults: defaults) == .purple,
          "the Settings colour applies to folders without their own")
    check(DirectoryColorPreferences.color(for: "finance", defaults: defaults) == .orange,
          "a folder's own colour wins over the Settings colour")
    check(announced == 1, "highlights redraw once when the colour changes, and not when it stays the same")
    check(DirectoryColorPreferences.ownColor(for: "finance", defaults: defaults) == .orange
          && DirectoryColorPreferences.ownColor(for: "research", defaults: defaults) == nil,
          "a folder's own colour is told apart from the default it shows")
    DirectoryColorPreferences.set(nil, for: "finance", defaults: defaults)
    check(DirectoryColorPreferences.ownColor(for: "finance", defaults: defaults) == nil
          && DirectoryColorPreferences.color(for: "finance", defaults: defaults) == .purple,
          "taking a colour back puts the folder on the default again, so Undo restores it as it was")

    check(LaunchHelper.note(for: .on).contains("log in") && LaunchHelper.note(for: .on).contains("\u{2318}L"),
          "Settings says Lasso starts at login and \u{2318}L starts it again after quitting")
    check(LaunchHelper.note(for: .needsApproval).contains("Login Items"),
          "a launcher switched off in System Settings says where to allow it")
    check([LaunchHelper.State.on, .needsApproval, .unavailable].allSatisfy { !LaunchHelper.note(for: $0).contains("\u{2014}") },
          "start notes contain no em dashes")
    check(LaunchHelper.bundlePath.hasPrefix("Contents/Library/LoginItems/"),
          "the launcher sits where macOS looks for an app's login items")
}

// ── Opening a source where it is cited ─────────────────────────────────────
do {
    print("\nOpening a source at its cited cell, page or line")
    let workbook = URL(fileURLWithPath: "/Users/me/Software Tests/Finance/Finance-Planning.xlsx")
    let csv = URL(fileURLWithPath: "/Users/me/Software Tests/Finance/Budget-vs-Actual.csv")
    let pdf = URL(fileURLWithPath: "/Users/me/Software Tests/Legal/Orchard-Services-Agreement.pdf")
    let markdown = URL(fileURLWithPath: "/Users/me/Software Tests/Finance/Finance-Brief.md")
    let memo = URL(fileURLWithPath: "/Users/me/Software Tests/Legal/Memo.docx")
    let cell = AssistOpenTarget(sheet: "Budget vs Actual", cell: "C27")

    let payload: [String: Any] = [
        "path": "Finance-Planning.xlsx",
        "source": ["filename": "Finance-Planning.xlsx", "location": "Budget vs Actual!C25"],
        "preview": ["columns": ["C"], "rows": [["rowNumber": 27, "cells": [["value": "14,000", "cited": true]]]],
                    "location": "Budget vs Actual · C27",
                    "openAt": ["sheet": "Budget vs Actual", "cell": "C27"]],
    ]
    let parsed = AssistDocumentPreview.parse(try! JSONSerialization.data(withJSONObject: payload))!
    check(parsed.openTarget == cell, "the card keeps the server's physical cell (C27), not the compacted source location")
    check(AssistOpenTarget(json: ["cell": "C0"]) == nil && AssistOpenTarget(json: ["cell": "27C"]) == nil
          && AssistOpenTarget(json: ["cell": "C27; quit"]) == nil && AssistOpenTarget(json: ["page": 0]) == nil
          && AssistOpenTarget(json: ["page": "3"]) == nil && AssistOpenTarget(json: ["page": true]) == nil
          && AssistOpenTarget(json: ["line": -1]) == nil && AssistOpenTarget(json: "C27") == nil,
          "malformed cells, pages and lines name no place to open")
    check(AssistOpenTarget(json: ["sheet": "Bad\u{0007}Sheet", "cell": "B3"]) == AssistOpenTarget(cell: "B3"),
          "a sheet name with control characters is dropped, keeping its cell")

    // A quoted phrase's video opens at the moment it is said, in QuickTime Player.
    check(AssistOpenTarget(json: ["time": 2.34])?.time == 2.34 && AssistOpenTarget(json: ["time": 0])?.time == 0
          && AssistOpenTarget(json: ["time": -1]) == nil && AssistOpenTarget(json: ["time": "2"]) == nil
          && AssistOpenTarget(json: ["time": true]) == nil && AssistOpenTarget(json: ["time": Double.infinity]) == nil,
          "a video time is a finite, non-negative number of seconds")
    let clip = URL(fileURLWithPath: "/tmp/Site Visit/site-visit.mp4")
    check(AssistOpenPlanner.plan(fileURL: clip, target: AssistOpenTarget(time: 2.34), appBundleID: "com.apple.QuickTimePlayerX")
            == .script(.quickTime, arguments: ["site-visit.mp4", "2340"])
          && AssistOpenPlanner.plan(fileURL: clip, target: AssistOpenTarget(page: 2), appBundleID: "com.apple.QuickTimePlayerX") == .plain,
          "QuickTime Player is told the quoted moment in whole milliseconds")
    check(AssistOpenScript.quickTime.source.contains("set current time of targetDocument")
          && AssistOpenScript.quickTime.source.contains("play targetDocument"),
          "the QuickTime script cues the moment and plays from it")
    check(AssistVideoTime.label(2.34) == "0:02" && AssistVideoTime.label(754.9) == "12:34"
          && AssistVideoTime.label(3723) == "1:02:03" && AssistVideoTime.milliseconds(6.1805) == "6181",
          "video times read as a player shows them")
    let videoPreview = AssistDocumentPreview.parse(try! JSONSerialization.data(withJSONObject: [
        "path": "site-visit.mp4", "source": ["filename": "site-visit.mp4"],
        "preview": ["kind": "video", "localPath": "/tmp/Site Visit/site-visit.mp4", "startTime": 2.34, "duration": 10.5,
                    "location": "Said at 0:02", "openAt": ["time": 2.34],
                    "lines": [["value": "[0:00] Welcome.", "cited": false],
                              ["value": "[0:01] The concrete pour starts.", "cited": true]]]]))!
    check(videoPreview.video?.fileURL.path == "/tmp/Site Visit/site-visit.mp4" && videoPreview.video?.startTime == 2.34
          && videoPreview.openTarget?.time == 2.34 && videoPreview.textBlocks.count == 2
          && videoPreview.textBlocks[1].cited && videoPreview.location == "Said at 0:02",
          "a video preview plays its own file from the quoted moment over its transcript")
    check(AssistVideoPreview(json: ["kind": "video", "localPath": "relative.mp4", "startTime": 1]) == nil
          && AssistVideoPreview(json: ["kind": "text", "localPath": "/a.mp4", "startTime": 1]) == nil,
          "a video preview needs the video's full path")
    check(AssistSuggestionSemantics.insertionText(claimType: "QUOTED_PHRASE", label: "The concrete pour starts.",
                                                  value: "The concrete pour starts.", completionText: " (site-visit.mp4, 0:02)")
            == " (site-visit.mp4, 0:02)"
          && AssistSuggestionSemantics.passage(of: ["quotedPhrase": "concrete pour starts",
                                                    "metadata": ["componentType": "VIDEO_SEGMENT"]]) == "concrete pour starts",
          "accepting a quoted phrase cites its video and moment, and its preview looks for the quoted words")

    // A PDF card opens at the page it rendered, which can follow the cited
    // text to a later page than the indexed one.
    var shownPDF = AssistDocumentPreview.parse(try! JSONSerialization.data(withJSONObject: [
        "path": "Plan.pdf", "source": ["filename": "Plan.pdf"],
        "preview": ["kind": "pdf", "fileUrl": "/api/source", "pageNumber": 2, "openAt": ["page": 2]]]))!
    check(shownPDF.openTargetAsShown == AssistOpenTarget(page: 2), "a PDF card opens at its indexed page before rendering")
    shownPDF.pdfPage = AssistPDFPageImage(image: NSImage(size: NSSize(width: 4, height: 4)), pageNumber: 4, highlighted: true)
    check(shownPDF.openTargetAsShown == AssistOpenTarget(page: 4), "a PDF card opens at the page it shows")

    func plan(_ url: URL, _ target: AssistOpenTarget?, _ app: String?) -> AssistOpenPlan {
        AssistOpenPlanner.plan(fileURL: url, target: target, appBundleID: app)
    }
    check(plan(workbook, cell, "com.microsoft.Excel")
          == .script(.excel, arguments: ["Finance-Planning.xlsx", "Budget vs Actual", "C27"]),
          "Excel selects the cited cell on its worksheet")
    check(plan(csv, AssistOpenTarget(cell: "B3"), "com.microsoft.Excel")
          == .script(.excel, arguments: ["Budget-vs-Actual.csv", "", "B3"]),
          "a CSV in Excel selects its cell on the only sheet")
    check(plan(csv, AssistOpenTarget(cell: "B3"), "com.apple.iWork.Numbers")
          == .script(.numbers, arguments: ["Budget-vs-Actual.csv", "Budget-vs-Actual", "", "B3"]),
          "Numbers selects the cell in the document it imported")
    check(plan(pdf, AssistOpenTarget(page: 3), "com.apple.Preview") == .previewPage(3),
          "Preview goes to the cited page")
    check(plan(pdf, AssistOpenTarget(page: 3), "com.adobe.Acrobat.Pro")
          == .script(.acrobat, arguments: ["Orchard-Services-Agreement.pdf", "3"])
          && plan(pdf, AssistOpenTarget(page: 3), "com.adobe.Reader")
          == .script(.adobeReader, arguments: ["Orchard-Services-Agreement.pdf", "3"]),
          "Acrobat and Acrobat Reader go to the cited page")
    check(plan(memo, AssistOpenTarget(line: 2, text: "Payment is due within 30 days."), "com.microsoft.Word")
          == .script(.word, arguments: ["Memo.docx", "Payment is due within 30 days.", "1"]),
          "Word finds the cited words")
    check(plan(memo, AssistOpenTarget(line: 5, text: "Fees", occurrence: 2), "com.microsoft.Word")
          == .script(.word, arguments: ["Memo.docx", "Fees", "2"])
          && AssistOpenTarget(json: ["text": "Fees", "occurrence": 2])?.occurrence == 2
          && AssistOpenTarget(json: ["text": "Fees", "occurrence": 0])?.occurrence == nil,
          "Word skips earlier matches of repeated words, such as a contents entry")
    check(AssistOpenPlanner.wordFindText("Cost ^ ratio\tnet\nsecond line") == "Cost ^^ ratio^tnet",
          "Word's search codes are escaped and only the first line is searched")
    let long = String(repeating: "budget ", count: 80)
    let found = AssistOpenPlanner.wordFindText(long)!
    check(found.count <= 255 && found.hasPrefix("budget budget") && !found.hasSuffix(" "),
          "a long passage is shortened at a word to Word's 255-character search limit")
    check(plan(markdown, AssistOpenTarget(line: 3), "com.microsoft.VSCode")
          == .url(URL(string: "vscode://file/Users/me/Software%20Tests/Finance/Finance-Brief.md:3")!),
          "VS Code opens text at the cited line")
    check(plan(csv, AssistOpenTarget(cell: "B12", line: 13), "com.microsoft.VSCode")
          == .url(URL(string: "vscode://file/Users/me/Software%20Tests/Finance/Budget-vs-Actual.csv:13")!)
          && plan(csv, AssistOpenTarget(cell: "B12"), "com.microsoft.VSCode") == .plain,
          "a CSV record opens at its text line, which a quoted field can push past its row number")
    if case .url(let url) = plan(markdown, AssistOpenTarget(line: 3), "com.barebones.bbedit") {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        check(url.scheme == "x-bbedit" && items.first { $0.name == "line" }?.value == "3"
              && items.first { $0.name == "url" }?.value == markdown.absoluteString,
              "BBEdit opens text at the cited line")
    } else {
        check(false, "BBEdit opens text at the cited line")
    }
    check(plan(workbook, cell, nil) == .plain && plan(workbook, nil, "com.microsoft.Excel") == .plain
          && plan(pdf, AssistOpenTarget(page: 3), "com.microsoft.Excel") == .plain
          && plan(markdown, AssistOpenTarget(line: 3), "com.apple.TextEdit") == .plain
          && plan(memo, AssistOpenTarget(line: 2), "com.microsoft.Word") == .plain,
          "apps without a way to the cited place, or with nothing to find, open the file plainly")
    let deck = URL(fileURLWithPath: "/Users/me/Software Tests/Board/Quarterly-Review.pptx")
    check(AssistOpenTarget(json: ["slide": 3]) == AssistOpenTarget(slide: 3)
          && AssistOpenTarget(json: ["slide": 0]) == nil && AssistOpenTarget(json: ["slide": "3"]) == nil,
          "a slide is a place to open; a malformed one is not")
    check(plan(deck, AssistOpenTarget(slide: 3), "com.microsoft.Powerpoint")
          == .script(.powerPoint, arguments: ["Quarterly-Review.pptx", "3"]),
          "PowerPoint goes to the cited slide")
    check(plan(deck, AssistOpenTarget(slide: 3), "com.apple.iWork.Keynote")
          == .script(.keynote, arguments: ["Quarterly-Review.pptx", "Quarterly-Review", "3"]),
          "Keynote goes to the cited slide in the document it imported")
    check(plan(deck, AssistOpenTarget(slide: 3), "com.apple.Preview") == .plain
          && plan(deck, AssistOpenTarget(line: 3), "com.microsoft.Powerpoint") == .plain,
          "an app without slides, or a deck without a slide, opens plainly")
    check(AssistOpenScript.allCases.allSatisfy { $0.source.contains("on run argv") },
          "every script reads its file, sheet, cell or words as arguments, never spliced into its source")
    check(AssistOpenScript.allCases.allSatisfy { $0.source.contains("tell application id \"\($0.appBundleID)\"") }
          && AssistOpenScript.numbers.appBundleID == "com.apple.iWork.Numbers"
          && AssistOpenScript.adobeReader.appBundleID == "com.adobe.Reader",
          "each script addresses the app whose launch the opener waits for")
    check(AssistOpenScript.allCases.allSatisfy { $0.source.contains("-1743") },
          "every script stops waiting as soon as macOS refuses it permission")
    // A script compiles against its app's own dictionary, where a variable
    // named like one of the app's terms (Excel's `code`) breaks all of it.
    for script in AssistOpenScript.allCases {
        var error: NSDictionary?
        let compiled = NSAppleScript(source: script.source)?.compileAndReturnError(&error) ?? false
        let appMissing = (error?[NSAppleScript.errorNumber] as? Int) == -1728
        check(compiled || appMissing, "the \(script.rawValue) script compiles wherever its app is installed")
    }
    let refusal = "execution error: Microsoft Excel got an error: Can\u{2019}t get worksheet \"Q3 Salaries\". (-1728)"
    check(AssistOpenScript.excel.failureSummary(errorOutput: refusal) == "excel (error -1728)"
          && AssistOpenScript.word.failureSummary(errorOutput: "") == "word",
          "a failed jump is logged by app and error number, never with file or sheet names")

    var steps: [String] = []
    let actions = AssistOpenActions(
        openFile: { steps.append("file:\($0.lastPathComponent)"); return true },
        openURL: { steps.append("url:\($0.scheme ?? "")"); return false },
        runScript: { script, _ in steps.append("script:\(script.rawValue)") },
        goToPreviewPage: { page, _ in steps.append("page:\(page)") })
    check(AssistSourceOpening.perform(.script(.excel, arguments: []), fileURL: workbook, actions: actions)
          && steps == ["file:Finance-Planning.xlsx", "script:excel"],
          "the file opens before its app is asked to move, so a refused jump still opens it")
    steps = []
    check(AssistSourceOpening.perform(.url(URL(string: "vscode://file/x:3")!), fileURL: markdown, actions: actions)
          && steps == ["url:vscode", "file:Finance-Brief.md"],
          "an editor link that cannot open falls back to opening the file")
    steps = []
    var refusing = actions
    refusing.openFile = { steps.append("file:\($0.lastPathComponent)"); return false }
    check(!AssistSourceOpening.perform(.previewPage(3), fileURL: pdf, actions: refusing)
          && steps == ["file:Orchard-Services-Agreement.pdf"],
          "a file macOS cannot open reports failure and starts no jump")
}

// ── Settings: keyboard shortcuts ──────────────────────────────────────────
// Settings > Shortcuts reads public/shortcuts.json, the list the Windows
// workspace shows too, and keeps only what exists on the Mac.

do {
    let fixture = """
    {"sections": [
      {"title": "Both", "note": "", "shortcuts": [
        {"action": "Search", "macos": "⌘K", "windows": "Ctrl+K"},
        {"action": "Open the source", "windows": "F4"},
        {"action": "Blank", "macos": ""}]},
      {"title": "Windows only", "shortcuts": [{"action": "Open the source", "windows": "F4"}]},
      {"title": "Mac only", "note": "While Lasso is off.", "shortcuts": [{"action": "Start Lasso", "macos": "⌘L"}]}
    ]}
    """
    let sections = try ShortcutCatalog.decode(Data(fixture.utf8)).macSections
    check(sections.map(\.title) == ["Both", "Mac only"], "sections with no Mac shortcuts are left out of Settings")
    check(sections.first?.rows == [ShortcutCatalog.Row(action: "Search", keys: "⌘K")],
          "Windows-only and keyless shortcuts are left out, and Mac keys are shown")
    check(sections.first?.note == nil && sections.last?.note == "While Lasso is off.",
          "an empty section note is not shown")
    check((try? ShortcutCatalog.decode(Data("{\"sections\": 3}".utf8))) == nil,
          "a malformed list is reported instead of shown empty")

    let catalog = try ShortcutCatalog.decode(Data(contentsOf: URL(fileURLWithPath: "public/shortcuts.json")))
    let mac = catalog.macSections
    let keys = mac.flatMap { $0.rows.map(\.keys) }
    check(mac.first?.title == "Lasso" && keys.contains("⌘,") && keys.contains("⌘L"),
          "the shipped list starts with Lasso's own commands, including ⌘L")
    check(mac.first?.rows.filter { $0.keys == "⇧⌘R" }.count == 1 && keys.filter { $0 == "⇧⌘R" }.count == 1,
          "⇧⌘R is listed once, for The Ranch, since Lasso holds it in every app")
    check(keys.contains("⇥") && keys.contains("⌘↩") && keys.contains("⇧⌘↩") && keys.contains("fn ←"),
          "the shipped list names every key the suggestion card answers to")
    check(!keys.contains("F4") && !keys.contains { $0.contains("Ctrl") },
          "the Mac never shows Windows keys")

    check(ShortcutCatalog.spokenKeys("⇧⌘↩") == "Shift Command Return"
          && ShortcutCatalog.spokenKeys("fn ←") == "fn Left Arrow"
          && ShortcutCatalog.spokenKeys("⌘1…9") == "Command 1 to 9"
          && ShortcutCatalog.spokenKeys("Esc") == "Esc",
          "VoiceOver reads shortcut symbols as key names")
} catch {
    check(false, "the shortcut list decodes (\(error))")
}

// ── External drives in the menu bar panel ──────────────────────────────────
// Drive choices are made in the panel, not in the browser workspace.

print("external drives")
do {
    let listing = """
    {"supported": true, "drives": [
      {"id": "macos-volume:aa", "name": "Backup", "rootPath": "/Volumes/Backup", "connected": true,
       "pendingAction": "connected", "projects": []},
      {"id": "macos-volume:bb", "name": "Archive", "rootPath": "/Volumes/Archive", "connected": false,
       "pendingAction": null, "projects": [{"id": "p1", "name": "Archive / Jobs"}, {"id": "p2", "name": "Archive / Bids"}]},
      {"id": "macos-volume:cc", "name": "Field", "rootPath": "/Volumes/Field", "connected": false,
       "pendingAction": "disconnected", "projects": [{"id": "p3", "name": "Field"}]},
      {"name": "No identity"}
    ]}
    """
    let drives = ExternalDrive.list(from: Data(listing.utf8)) ?? []
    check(drives.map(\.id) == ["macos-volume:aa", "macos-volume:bb", "macos-volume:cc"],
          "the drive list keeps the server's order and skips a drive without an identity")
    check(ExternalDrive.list(from: Data("{\"error\": \"nope\"}".utf8)) == nil && ExternalDrive.list(from: nil) == nil,
          "an unreadable drive answer is reported instead of shown as no drives")
    check(drives.map(\.title) == ["Backup (needs a decision)", "Archive (offline)", "Field (needs a decision)"],
          "drive titles say which one is waiting for a decision or offline, like work directories")
    check(drives[1].workspaces == ["Archive / Jobs", "Archive / Bids"], "a drive lists the workspaces indexed from it")
    check(drives[0].summary == "Connected. Lasso reads only the files you choose."
          && drives[1].summary == "Disconnected. Its 2 saved indexes stay searchable."
          && drives[2].summary == "Disconnected. Its saved index stays searchable.",
          "each drive says what Lasso holds for it")

    let backup = drives[0]
    check(backup.relativePaths([URL(fileURLWithPath: "/Volumes/Backup")]) == ["."],
          "choosing the drive itself indexes the whole drive")
    check(backup.relativePaths([URL(fileURLWithPath: "/Volumes/Backup/Jobs/2026"),
                                URL(fileURLWithPath: "/Volumes/Backup/Bids/")]) == ["Jobs/2026", "Bids"],
          "chosen folders are sent relative to the drive")
    check(backup.relativePaths([URL(fileURLWithPath: "/Volumes/Backup/Jobs"),
                                URL(fileURLWithPath: "/Users/me/Documents")]) == nil,
          "a folder outside the drive cancels the whole choice")
    check(backup.relativePaths([URL(fileURLWithPath: "/Volumes/Backup2/Jobs")]) == nil,
          "a drive whose name starts the same is not inside this drive")

    let body = WorkspaceAPI.driveIndexBody(["Jobs"])
    check(body["paths"] as? [String] == ["Jobs"] && (body["actor"] as? [String: String])?["actorType"] == "HUMAN_SELF",
          "indexing a drive is recorded as the person at this Mac")
    check(WorkspaceAPI.drivePath("macos-volume:aa", "index") == "api/drives/macos-volume:aa/index",
          "drive requests address the drive by its volume identity")

    let removal = drives[2].removalConfirmation()
    check(removal.message == "Remove saved data for \u{201C}Field\u{201D}?"
          && removal.details.contains("can\u{2019}t be undone") && removal.details.contains("files on the drive"),
          "removing a drive's saved data asks first and says the drive itself is untouched")
    check(removal.details.contains("not yet saved"),
          "removing a drive's saved data warns that unsaved edits to its files go with it")
    check(drives[2].removalConfirmation(shown: "/Volumes/Field").message.contains("/Volumes/Field"),
          "the removal alert names the drive the way the list shows it")

    let menu = ExternalDriveMenu()
    menu.drives = drives
    let group = menu.item(ready: true, idle: true)
    check(group.title == "External Drives" && group.submenu?.items.map(\.title) == drives.map(\.title),
          "External Drives opens to a row for each drive")
    func choices(_ index: Int, in item: NSMenuItem) -> [String] {
        item.submenu?.items[index].submenu?.items.filter { $0.action != nil }.map(\.title) ?? []
    }
    check(choices(0, in: group) == ["Index Entire Drive", "Choose Folders\u{2026}", "Not Now"],
          "a newly connected drive offers to index all of it, choose folders, or wait")
    check(choices(1, in: group) == ["Remove Saved Data\u{2026}"],
          "an offline drive that is not waiting for a decision offers only removal")
    check(choices(2, in: group) == ["Keep Saved Index", "Remove Saved Data\u{2026}"],
          "a drive that was just disconnected offers to keep or remove its saved index")
    check(group.submenu?.items[0].submenu?.items.first?.action == nil
          && group.submenu?.items[0].submenu?.items.first?.title == drives[0].summary,
          "each drive's choices start with what Lasso holds for it")
    let busy = menu.item(ready: true, idle: false)
    check(busy.isEnabled && busy.submenu?.items[0].submenu?.items.filter { $0.action != nil }.allSatisfy { !$0.isEnabled } == true,
          "drive choices wait while another request runs, but the list stays open")
    check(!menu.item(ready: false, idle: true).isEnabled, "External Drives waits for the server")
    check(menu.attentionPath == ["External Drives", "Backup (needs a decision)"],
          "a review opens the first drive that is waiting for a decision")

    let twins = ExternalDrive.list(from: Data("""
    {"drives": [
      {"id": "x", "name": "Untitled", "rootPath": "/Volumes/Untitled", "connected": true, "pendingAction": "connected"},
      {"id": "y", "name": "Untitled", "rootPath": "/Volumes/Untitled 1", "connected": true, "pendingAction": null}]}
    """.utf8)) ?? []
    menu.drives = twins
    check(menu.item(ready: true, idle: true).submenu?.items.map(\.title)
          == ["/Volumes/Untitled (needs a decision)", "/Volumes/Untitled 1"]
          && menu.attentionPath.last == "/Volumes/Untitled (needs a decision)",
          "drives with the same name are told apart by their paths, like work directories")

    menu.drives = []
    let empty = menu.item(ready: true, idle: true)
    check(empty.submenu?.items.count == 1 && empty.submenu?.items.first?.action == nil
          && empty.submenu?.items.first?.title.hasPrefix("Connect an external drive") == true,
          "with no drives, the group says how to add one")
    check(menu.attentionPath == ["External Drives"], "a review with nothing pending opens the drive list")
}

print("Code colours")
do {
    let syntax = try CodeSyntax(data: Data(contentsOf: URL(fileURLWithPath: "public/code-syntax.json")))
    // public/code-syntax.js is held to the same cases by test/code-syntax.test.js.
    let cases = try JSONSerialization.jsonObject(
        with: Data(contentsOf: URL(fileURLWithPath: "test/fixtures/code-syntax-cases.json"))) as? [[String: Any]] ?? []
    check(cases.count >= 10, "the shared colouring cases are read")
    for sample in cases {
        let file = sample["file"] as? String ?? "", text = sample["text"] as? String ?? ""
        let expected = sample["tokens"] as? [[String]] ?? []
        let tokens = syntax.language(forFileName: file)?.tokens(in: text) ?? []
        let found = tokens.map { [$0.kind.rawValue, (text as NSString).substring(with: $0.range)] }
        check(found == expected, "colours \(file) as the inspector does: \(sample["about"] as? String ?? "")")
        if found != expected { print("    found \(found)") }
    }
    check(syntax.language(forFileName: "/repo/Dockerfile")?.name == "Dockerfile"
          && syntax.language(forFileName: "src/App.TSX")?.name == "JavaScript"
          && syntax.language(forFileName: "C:\\work\\job.PS1")?.name == "PowerShell"
          && syntax.language(forFileName: "notes.txt") == nil && syntax.language(forFileName: "") == nil,
          "a language is found by file name before extension, ignoring case and folders")

    let script = syntax.language(forFileName: "a.js")!
    let spanning = script.lineTokens(["let a = 1; /* one", "two", "three */ b"])
    check(spanning.map { $0.map(\.kind) } == [[.keyword, .variable, .number, .comment], [.comment], [.comment]]
          && spanning[0][3].range == NSRange(location: 11, length: 6) && spanning[2][0].range == NSRange(location: 0, length: 8),
          "a block comment opened on one line colours the lines it runs on")

    func shade(_ color: NSColor, _ name: NSAppearance.Name) -> String {
        var hex = ""
        NSAppearance(named: name)!.performAsCurrentDrawingAppearance {
            let rgb = color.usingColorSpace(.sRGB)!
            hex = String(format: "#%02X%02X%02X", Int((rgb.redComponent * 255).rounded()),
                         Int((rgb.greenComponent * 255).rounded()), Int((rgb.blueComponent * 255).rounded()))
        }
        return hex
    }
    let keyword = syntax.palette.color(for: .keyword)
    check(shade(keyword, .aqua) == "#9B2393" && shade(keyword, .darkAqua) == "#FC5FA3",
          "keywords take Xcode's light and dark colours as the appearance changes")

    let payload: [String: Any] = [
        "source": ["filename": "ratelimit.py", "location": "Line 2"], "path": "service/ratelimit.py",
        "preview": ["kind": "text", "format": "plain", "lines": [
            ["value": "def allow(self):", "lineNumber": 1], ["value": "    return True", "lineNumber": 2, "cited": true]]],
    ]
    let card = AssistDocumentPreview.parse(try JSONSerialization.data(withJSONObject: payload), syntax: syntax)!
    check(card.textBlocks.map { $0.codeTokens.map(\.kind) } == [[.keyword, .variable, .keyword], [.keyword, .keyword]],
          "the suggestion card colours a code file's lines")
    let drawn = AssistMarkdown.attributed(card.textBlocks[1], baseSize: 11)
    let returnColor = drawn.attribute(.foregroundColor, at: 4, effectiveRange: nil) as? NSColor
    let returnFont = drawn.attribute(.font, at: 4, effectiveRange: nil) as? NSFont
    let plainColor = drawn.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor
    check(returnColor.map { shade($0, .aqua) } == "#9B2393" && plainColor == .labelColor
          && returnFont?.isFixedPitch == true && returnFont?.fontDescriptor.symbolicTraits.contains(.bold) == true,
          "a coloured line draws its keywords in bold keyword colour and leaves its indent plain")
    var prose = payload
    prose["source"] = ["filename": "notes.txt"]
    let notes = AssistDocumentPreview.parse(try JSONSerialization.data(withJSONObject: prose), syntax: syntax)!
    check(notes.textBlocks.allSatisfy { $0.codeTokens.isEmpty }, "prose lines are not coloured")
}

// MARK: The Ranch

do {
    func source(_ id: String, _ directory: String, _ name: String, modified: String?, created: String?,
                used: String? = nil, activity: Double = 0) -> String {
        let quote: (String?) -> String = { $0.map { "\"\($0)\"" } ?? "null" }
        return """
        {"id": "\(id)", "directoryId": "\(directory)", "path": "Reports/\(name)", "name": "\(name)", "kind": "spreadsheet",
         "fileType": "spreadsheet", "size": 2048, "contentHash": "h-\(id)", "modifiedAt": \(quote(modified)),
         "createdAt": \(quote(created)), "lastUsedAt": \(quote(used)),
         "counts": {"tabs": 1, "opens": 0, "visits": 2, "shares": 0, "references": 0}, "activeShares": 0, "activity": \(activity)}
        """
    }
    func directory(_ id: String, _ name: String, edited: String?, used: String?, created: String?, kind: String = "folder") -> String {
        let quote: (String?) -> String = { $0.map { "\"\($0)\"" } ?? "null" }
        return """
        {"id": "\(id)", "name": "\(name)", "rootPath": "/tmp/\(name)", "kind": "\(kind)", "symbol": null, "active": true,
         "available": true, "offline": false, "snapshotId": "s-\(id)", "fileCount": 2, "listedCount": 2, "issue": null,
         "createdAt": \(quote(created)), "addedAt": "2026-09-01T00:00:00.000Z", "lastEditedAt": \(quote(edited)),
         "lastUsedAt": \(quote(used)), "activity": 0.5}
        """
    }
    let json = """
    {"generatedAt": "2026-10-23T12:00:00.000Z", "truncated": false,
     "directories": [\(directory("d1", "Finance", edited: "2026-10-20T10:00:00.000Z", used: nil, created: "2025-01-01T00:00:00.000Z")),
                     \(directory("d2", "Models", edited: "2026-10-22T10:00:00.000Z", used: "2026-10-21T10:00:00.000Z", created: "2026-03-01T00:00:00.000Z")),
                     \(directory("d3", "Outlook", edited: nil, used: nil, created: nil, kind: "app"))],
     "sources": [\(source("a", "d1", "Budget.xlsx", modified: "2026-10-19T10:00:00.000Z", created: "2026-01-01T00:00:00Z", activity: 1)),
                 \(source("b", "d1", "Actuals.xlsx", modified: "2026-10-20T10:00:00.000Z", created: "2025-06-01T00:00:00.000Z",
                          used: "2026-10-22T09:00:00.000Z", activity: 0.4)),
                 \(source("c", "d2", "Bracket.step", modified: nil, created: nil)),
                 \(source("d", "d2", "Plate.step", modified: "2026-10-01T10:00:00.000Z", created: "2026-02-01T00:00:00.000Z"))],
     "history": [{"id": "e1", "directoryId": "d1", "at": "2026-10-20T10:00:00.000Z", "change": "edited",
                  "path": "Reports/Actuals.xlsx", "previousPath": null, "fileId": "b"},
                 {"id": "e2", "directoryId": "d2", "at": "2026-10-10T10:00:00.000Z", "change": "directory-added",
                  "path": null, "previousPath": null, "fileCount": 2}],
     "historyTruncated": false,
     "links": {"outgoing": [{"id": "l1", "kind": "OBJECT", "token": "t", "url": "http://127.0.0.1:4319/d/t", "directoryId": "d1",
                             "path": "Reports/Budget.xlsx", "fileId": "a", "name": "Budget.xlsx", "locator": null, "scope": "DOCUMENT",
                             "status": "active", "drifted": false, "createdAt": "2026-10-22T10:00:00.000Z",
                             "expiresAt": "2026-10-24T10:00:00.000Z", "revokedAt": null}],
               "received": []},
     "review": [{"id": "r1", "kind": "changed", "title": "Linked value changed", "directoryId": "d1",
                 "path": "Reports/Budget.xlsx", "fileId": "a", "documents": ["Memo.md"], "detail": "Changed."}],
     "network": {"edges": [{"from": "a", "to": "c", "kind": "mention", "weight": 0.75},
                           {"from": "a", "to": "b", "kind": "link", "weight": 2}]}}
    """
    let overview = try? RanchOverview.decode(Data(json.utf8))
    check(overview?.sources.count == 4 && overview?.history.last?.fileCount == 2
          && overview?.links.outgoing.first?.expiresAt != nil && overview?.sources[2].modifiedAt == nil,
          "The Ranch decodes the server's overview, with and without fractional seconds, and its nulls")
    if let overview {
        let names = { (directories: [RanchDirectory]) in directories.map(\.name) }
        check(names(RanchOrder.lastEdited.sorted(overview.directories)) == ["Models", "Finance", "Outlook"],
              "directories ordered by last edit put the latest first and undated ones last")
        check(names(RanchOrder.recentlyUsed.sorted(overview.directories)) == ["Models", "Finance", "Outlook"],
              "never-used directories go after used ones, by name")
        check(names(RanchOrder.oldest.sorted(overview.directories)) == ["Finance", "Models", "Outlook"]
              && names(RanchOrder.newest.sorted(overview.directories)) == ["Outlook", "Models", "Finance"],
              "oldest and newest order directories by when they were made, or added when that is unknown")
        let files = { (sources: [RanchSource]) in sources.map(\.id) }
        check(files(RanchOrder.lastEdited.sorted(overview.sources)) == ["b", "a", "d", "c"]
              && files(RanchOrder.recentlyUsed.sorted(overview.sources)) == ["b", "c", "a", "d"]
              && files(RanchOrder.oldest.sorted(overview.sources)) == ["b", "a", "d", "c"],
              "files sort by their own order, separately from directories")
        check(overview.sources[0].folder == "Reports" && overview.sources[2].fileExtension == "step",
              "a file knows its folder and extension")
        check(overview.sources[0].counts.summary == "Tabbed once \u{00B7} Viewed twice" && RanchCounts.none.summary == "Not used yet",
              "use is summarised in words, leaving out what never happened")

        let defaults = MemoryDirectoryDefaults()
        defaults.set(RanchOrder.oldest.rawValue, forKey: RanchOrder.directoryKey)
        check(RanchOrder.saved(RanchOrder.directoryKey, defaults: defaults) == .oldest
              && RanchOrder.saved(RanchOrder.itemKey, defaults: defaults) == .lastEdited,
              "directory and file orders are remembered under separate keys")

        let layout = RanchNetworkLayout.make(overview)
        let fileIDs = Set(layout.nodes.filter { $0.role == .file }.map(\.id))
        check(fileIDs == ["a", "b", "c"] && !layout.isStarter,
              "the network draws used and connected files, not unused loners")
        check(layout.nodes.filter { $0.role == .hub }.map(\.label) == ["Finance", "Models"],
              "each directory with files drawn is a hub")
        check(layout.lines.contains { $0.kind == "mention" && $0.crossesDirectories }
              && layout.lines.contains { $0.kind == "link" && !$0.crossesDirectories },
              "lines say whether they cross directories")
        check(layout == RanchNetworkLayout.make(overview), "the same library always lays out the same way")

        // The sources page's overview, counted from the same library.
        let today = ISO8601DateFormatter().date(from: "2026-10-23T12:00:00Z")!
        let whole = RanchLibrarySummary(sources: overview.sources, history: overview.history,
                                        links: overview.links.outgoing, directoryId: nil, now: today)
        check(whole.total == 4 && whole.usedCount == 4 && whole.totalUses == 12 && overview.sources[0].counts.total == 3,
              "the overview adds up every way a file was used")
        check(whole.kinds.map(\.kind) == ["spreadsheet"] && whole.kinds.first?.count == 4,
              "the overview counts files by kind")
        check(whole.changedThisWeek == 1 && whole.changedFiles.map(\.id) == ["b"],
              "a file edited in the last week counts as changed; a directory being added does not")
        check(whole.activeLinks == 1 && whole.allLinks == 1 && whole.expiringLinks == 1 && whole.driftedLinks == 0,
              "a working link that ends within a week is counted as expiring soon")
        let models = RanchLibrarySummary(sources: overview.sources, history: overview.history,
                                         links: overview.links.outgoing, directoryId: "d2", now: today)
        check(models.total == 2 && models.changedThisWeek == 0 && models.allLinks == 0 && models.top.map(\.id) == ["c", "d"],
              "one directory's overview counts only its own files, changes and links")
        let later = RanchLibrarySummary(sources: overview.sources, history: overview.history,
                                        links: overview.links.outgoing, directoryId: nil,
                                        now: today.addingTimeInterval(30 * 24 * 3600))
        check(later.changedThisWeek == 0, "a change more than a week old is no longer counted")
        check(RanchUseFilter.used.keeps(overview.sources[0]) && !RanchUseFilter.shared.keeps(overview.sources[0])
              && RanchUseFilter.all.keeps(overview.sources[0]),
              "In use keeps files that were used, Shared those with a working link")
        let busy = RanchLibrarySummary(sources: [], history: [], links: [], directoryId: nil)
        check(busy.total == 0 && !busy.anyUsed && busy.top.isEmpty && busy.kinds.isEmpty,
              "an empty library has an empty overview")
        check(RanchLibrarySummary.short(46) == "46" && RanchLibrarySummary.short(2140) == "2.1k"
              && RanchLibrarySummary.short(18400) == "18k",
              "a count too long for its circle is written in thousands")
        let box = CGSize(width: 260, height: 150)
        let circles = RanchCirclePacking.pack([1412, 806, 482, 147], in: box)
        var apart = true
        for first in circles.indices {
            for second in circles.indices where second > first {
                let distance = hypot(circles[first].x - circles[second].x, circles[first].y - circles[second].y)
                if distance < (circles[first].d + circles[second].d) / 2 { apart = false }
            }
        }
        let inside = circles.allSatisfy { $0.x - $0.d / 2 >= -0.5 && $0.x + $0.d / 2 <= box.width + 0.5
            && $0.y - $0.d / 2 >= -0.5 && $0.y + $0.d / 2 <= box.height + 0.5 }
        check(apart && inside, "the kinds' circles sit inside their card without touching")
        check(circles[0].d > circles[1].d && circles[1].d > circles[2].d && circles[2].d > circles[3].d,
              "a kind with more files gets a larger circle")
        check(RanchCirclePacking.pack([0, 0], in: box).allSatisfy { $0.d == 0 }, "kinds with no files draw no circle")
        let wide = RanchTableColumns(width: 900, showsDirectory: true)
        let narrow = RanchTableColumns(width: 600, showsDirectory: true)
        check(wide.kind && wide.directory && wide.usage && narrow.kind && !narrow.directory && !narrow.usage
              && !RanchTableColumns(width: 900, showsDirectory: false).directory,
              "a narrow table drops its directory and usage columns, and one directory's table never names it")
        var ticks = RanchDirectoryTicks()
        ticks.meet(overview.directories)
        check(ticks.count(overview.directories) == 3 && ticks.changes(overview.directories).isEmpty,
              "every directory Lasso reads starts ticked, and going on untouched changes nothing")
        ticks.toggle(overview.directories[0])
        check(ticks.changes(overview.directories) == [RanchDirectoryChange(id: "d1", active: false)]
              && ticks.count(overview.directories) == 2,
              "unticking a directory pauses it when the person goes on")
        ticks.toggle(overview.directories[0])
        check(ticks.changes(overview.directories).isEmpty, "ticking it again takes the pause back")
        ticks.toggle(overview.directories[2])
        check(ticks.isTicked(overview.directories[2]) && ticks.changes(overview.directories).isEmpty,
              "a connected app stays ticked; it is switched on and off where it was connected")
        let pausedJSON = json.replacingOccurrences(of: "\"name\": \"Finance\", \"rootPath\": \"/tmp/Finance\", \"kind\": \"folder\", \"symbol\": null, \"active\": true",
                                                   with: "\"name\": \"Finance\", \"rootPath\": \"/tmp/Finance\", \"kind\": \"folder\", \"symbol\": null, \"active\": false")
        if let paused = try? RanchOverview.decode(Data(pausedJSON.utf8)), !paused.directories[0].active {
            var resume = RanchDirectoryTicks()
            resume.meet(paused.directories)
            check(!resume.isTicked(paused.directories[0]), "a paused directory starts unticked")
            resume.toggle(paused.directories[0])
            check(resume.changes(paused.directories) == [RanchDirectoryChange(id: "d1", active: true)],
                  "ticking a paused directory resumes it")
            var later = RanchDirectoryTicks()
            later.meet(Array(overview.directories.prefix(1)))
            later.toggle(overview.directories[0])
            later.meet(overview.directories)
            check(later.changes(overview.directories) == [RanchDirectoryChange(id: "d1", active: false)]
                  && later.isTicked(overview.directories[1]),
                  "a directory added during the step comes in ticked and keeps the ticks already changed")
        } else {
            check(false, "a paused directory decodes")
        }
        let early = RanchDemoTime(t: 1, loop: 10)
        let late = RanchDemoTime(t: 9.9, loop: 10)
        check(early.ramp(0, 2, curve: .linear) == 0.5 && early.ramp(2, 3) == 0 && early.ramp(0, 0.5) == 1
              && early.ramp(0, 2) == 0.5,
              "a demo's ramps run from 0 to 1 across their span and hold outside it")
        check(RanchDemoTime(t: 0.9, loop: 10).ramp(0, 1, curve: .back) > 1 && RanchDemoTime(t: 1, loop: 10).ramp(0, 1, curve: .back) == 1,
              "a pop overshoots a little and settles where it belongs")
        check([RanchDemoTime.Curve.linear, .smooth, .out, .back].allSatisfy {
                  RanchDemoTime(t: 0.5, loop: 10).ramp(1, 2, curve: $0) == 0 && RanchDemoTime(t: 1, loop: 10).ramp(1, 2, curve: $0) == 0
              },
              "nothing has begun before its moment, whatever its curve")
        check(early.span(0.5, 3) == 1 && RanchDemoTime(t: 3.5, loop: 10).span(0.5, 3) == 0
              && early.press(1, length: 0.16) == 0 && RanchDemoTime(t: 1.08, loop: 10).press(1) == 1,
              "something shown for a span is gone after it, and a press is down only for its moment")
        check(early.fade == 1 && late.fade < 0.5 && RanchDemoTime(t: 0, loop: 10).fade == 0,
              "a demo fades in as its loop starts and out before it starts again")
        let path = RanchDemoPath(keys: [(0, CGPoint(x: 0, y: 0)), (1, CGPoint(x: 0, y: 0)), (3, CGPoint(x: 100, y: 50))])
        check(path.point(RanchDemoTime(t: 0.5, loop: 10)) == .zero && path.point(RanchDemoTime(t: 2, loop: 10)) == CGPoint(x: 50, y: 25)
              && path.point(RanchDemoTime(t: 5, loop: 10)) == CGPoint(x: 100, y: 50),
              "a demo's pointer holds at each stop and glides between them")
        check(abs(RanchPullPhysics.rubber(100) - 55) < 1e-9 && abs(RanchPullPhysics.rubber(180) - 99) < 1e-9
              && RanchPullPhysics.rubber(-20) == 0
              && RanchPullPhysics.rubber(160) >= RanchPullPhysics.threshold,
              "a pull moves the page half as far at first, so the refresh point is easy to reach")
        check(RanchPullPhysics.rubber(2000) < 159 && RanchPullPhysics.rubber(2000) > RanchPullPhysics.rubber(400),
              "past that the page resists more and more, and never goes further than about 159 points")
        var back = RanchSpring(RanchPullPhysics.threshold, RanchPullPhysics.back.k, RanchPullPhysics.back.c)
        back.t = 0
        var lowest = back.x
        for _ in 0..<(60 * 4 * 2) { back.step(1.0 / 240); lowest = min(lowest, back.x) }
        check(lowest < 0 && lowest > -12 && back.settled,
              "let go, the page springs home with one small overshoot and settles")
        var held = RanchSpring(0, RanchPullPhysics.follow.k, RanchPullPhysics.follow.c)
        held.t = 40
        var highest = held.x
        for _ in 0..<(60 * 4) { held.step(1.0 / 240); highest = max(highest, held.x) }
        check(highest <= 40.6 && held.settled, "while pulled, the page follows closely, overshooting by no more than a hair")
        var calm = RanchSpring(0, 0, 0)
        calm.tune(RanchPullPhysics.back, reduce: true)
        check(calm.c == 2 * RanchPullPhysics.back.k.squareRoot(), "with Reduce Motion the springs are critically damped")
        check(RanchShareWay.allCases.allSatisfy { $0.unavailable(for: "Lease.pdf") == nil },
              "a PDF can be shared whole, redacted or marked up")
        check(RanchShareWay.whole.unavailable(for: "deck-loads.xlsx") == nil
              && RanchShareWay.redacted.unavailable(for: "deck-loads.xlsx") == nil
              && RanchShareWay.marked.unavailable(for: "deck-loads.xlsx") != nil,
              "a spreadsheet can be shared whole or redacted, but not marked up, and says why")
        check(RanchShareWay.whole.unavailable(for: "site.mp4") == nil && RanchShareWay.redacted.unavailable(for: "site.mp4") != nil,
              "a video is shared whole only")
        check(RanchShareWay.whole.scope == .document && RanchShareWay.redacted.scope == .redacted && RanchShareWay.marked.scope == .marked,
              "each way of sharing makes the scope the server knows it by")
        check(RanchShareAddress.valid("sam@harbor.co") && !RanchShareAddress.valid("sam@harbor")
              && !RanchShareAddress.valid("sam harbor.co") && !RanchShareAddress.valid(""),
              "only what looks like an email address becomes a recipient")
        var rows = RanchSpringRows(count: 3, row: 56, pad: 6)
        rows.hover(0)
        check(rows.highlight.top == 6 && rows.highlight.height == 56, "the highlight starts on its row at once, with no slide")
        for _ in 0..<72 { rows.step(1.0 / 240) }
        rows.hover(2)
        var stretched = 0.0
        for _ in 0..<120 { rows.step(1.0 / 240); stretched = max(stretched, rows.highlight.height) }
        check(stretched > 80, "moving down two rows, the highlight stretches as its leading edge runs ahead")
        for _ in 0..<480 { rows.step(1.0 / 240) }
        check(abs(rows.highlight.top - 118) < 0.5 && abs(rows.highlight.height - 56) < 0.5,
              "and settles on the new row, its own height again")
        rows.choose(1)
        check(rows.presses[1].x == 0.955 && rows.ticks[1].t == 1 && rows.ticks[0].t == 0,
              "choosing a row draws its check and gives it a little press")
        check(RanchSpringRows.delay(0) == 0.05 && abs(RanchSpringRows.delay(2) - 0.14) < 1e-9,
              "rows fall in 45 milliseconds apart, as the component's stagger is")
        typealias Chips = RanchChipSearch
        let recents = ["dashboards", "empty states", "pricing pages"]
        let terms = ["dashboards", "data tables", "dark mode", "empty states", "onboarding", "pricing pages"]
        check(Chips.rows(query: "", chips: ["onboarding"], recents: recents, suggestions: terms).map(\.label) == recents
              && Chips.rows(query: " ", chips: [], recents: recents, suggestions: terms).allSatisfy { $0.kind == .recent },
              "with nothing typed, the chip search lists the recent searches")
        let typed = Chips.rows(query: "da", chips: ["onboarding"], recents: recents, suggestions: terms)
        check(typed.map(\.label) == ["da", "dashboards", "data tables", "dark mode"]
              && typed.map(\.kind) == [.query, .recent, .suggestion, .suggestion],
              "typing lists what was typed, then recents holding it, then suggestions, none twice")
        check(Chips.rows(query: "ON", chips: ["onboarding"], recents: [], suggestions: terms).map(\.label) == ["ON"],
              "a term that is already a chip is not offered again, whatever its case")
        check(Chips.rows(query: "a", chips: [], recents: [], suggestions: (1...9).map { "a\($0)" }).count == 1 + 6,
              "at most six matches follow what was typed")
        check(Chips.holds(Array("data tables".utf8), Array("a t".utf8)) && Chips.holds(Array("ab".utf8), [])
              && !Chips.holds(Array("ab".utf8), Array("abc".utf8)) && !Chips.holds(Array("aab".utf8), Array("abb".utf8)),
              "a term holds the typed bytes anywhere in it, and nothing longer than itself")
        let accented = Chips.Terms(["Été Report.pdf", "Plan.docx"])
        check(Chips.rows(query: "ÉTÉ", chips: [], recents: [], terms: accented).map(\.label) == ["ÉTÉ", "Été Report.pdf"],
              "terms are matched whatever their case, accented letters too")
        let marked = Chips.highlight("Data tables", query: "DA").map { String("Data tables"[$0]) }
        check(marked == "Da" && Chips.highlight("Data", query: "x") == nil && Chips.highlight("Data", query: "") == nil,
              "the typed part of a row is found whatever its case, to be drawn heavier")
        let added = Chips.add(" pricing pages ", chips: ["onboarding"], recents: recents)
        check(added.outcome == .added && added.chips == ["onboarding", "pricing pages"]
              && added.recents == ["pricing pages", "dashboards", "empty states"],
              "entering a term adds it as a chip, trimmed, and moves it to the top of the recents")
        let again = Chips.add("ONBOARDING", chips: ["onboarding"], recents: recents)
        check(again.outcome == .existing && again.chips == ["onboarding"] && again.recents.first == "ONBOARDING"
              && again.recents.count == 4,
              "a term already a chip is not added twice, though it still becomes the latest recent")
        let full = Chips.add("settings", chips: ["a", "b", "c", "d"], recents: recents)
        check(full.outcome == .full && full.chips.count == 4 && full.recents == recents,
              "a bar holding four chips takes no more and leaves the recents alone")
        check(Chips.add("  ", chips: [], recents: recents).outcome == .empty
              && Chips.add("x", chips: [], recents: ["a", "b", "c", "d", "e"]).recents == ["x", "a", "b", "c", "d"],
              "nothing typed adds nothing, and the recents keep five")
        let row = ["a", "b", "c"]
        check(Chips.step(nil, by: -1, in: row) == "c" && Chips.step("c", by: -1, in: row) == "b"
              && Chips.step("a", by: -1, in: row) == "a" && Chips.step("b", by: 1, in: row) == "c"
              && Chips.step("c", by: 1, in: row) == nil && Chips.step(nil, by: -1, in: []) == nil,
              "the left arrow walks back through the chips from the field, and the right arrow past the last leaves them")
        let budget = overview.sources[0]
        check(Chips.keeps(budget, chips: ["budget"], directoryName: "Finance")
              && Chips.keeps(budget, chips: ["REPORTS", "finance", "spreadsheet"], directoryName: "Finance")
              && !Chips.keeps(budget, chips: ["budget", "models"], directoryName: "Finance")
              && Chips.keeps(budget, chips: [], directoryName: "Finance"),
              "a file stays listed when every chip is in its name, folders, directory or kind")
        let offered = Chips.suggestions(sources: overview.sources, directories: overview.directories)
        check(offered == ["Finance", "Models", "Outlook", "Spreadsheet", "Actuals.xlsx", "Budget.xlsx", "Plate.step", "Bracket.step"],
              "the terms offered are the directories, the kinds, then the files edited most lately")
        check(RanchKindFilter.keeping("pdf") == .pdfs && RanchKindFilter.keeping("nothing") == nil
              && RanchKindFilter.label(for: "spreadsheet") == "Spreadsheet" && RanchKindFilter.label(for: "mystery") == "File",
              "a file's kind has a short label and a filter that keeps it")
        check(layout.nodes.allSatisfy { abs($0.position.x) <= 1 && abs($0.position.y) <= 1 },
              "every node stays inside the drawing")
        let finance = RanchNetworkLayout.make(overview, directoryId: "d1")
        check(Set(finance.nodes.filter { $0.role == .file }.map(\.id)) == ["a", "b", "c"],
              "one directory's network keeps the files elsewhere it connects to")
        check(RanchNetworkLayout.make(overview, maxFiles: 1).nodes.filter { $0.role == .file }.map(\.id) == ["a"],
              "past the limit, the busiest and best-connected files are kept")
        let quiet = RanchOverview(generatedAt: nil, truncated: false, directories: overview.directories,
                                  sources: overview.sources.map { source in
                                      RanchSource(id: source.id, directoryId: source.directoryId, path: source.path, name: source.name,
                                                  kind: source.kind, size: source.size, contentHash: source.contentHash,
                                                  modifiedAt: source.modifiedAt, createdAt: source.createdAt,
                                                  lastUsedAt: nil, counts: .none, activeShares: 0, activity: 0)
                                  }, history: [], historyTruncated: false, links: RanchLinks(outgoing: [], received: []), review: [],
                                  network: RanchNetworkData(edges: []))
        let starter = RanchNetworkLayout.make(quiet)
        check(starter.isStarter && starter.nodes.filter { $0.role == .file }.count == 4,
              "with nothing used or linked, recently edited files are drawn as a start")
        // A click that narrows the network, or the refresh after a visit, redraws
        // it under a resting pointer; the hovered node's old place may be gone.
        let narrowed = RanchNetworkLayout.make(overview, maxFiles: 1)
        let lastPlace = starter.nodes.count - 1
        check(!narrowed.nodes.indices.contains(lastPlace) && narrowed.index(of: starter.nodes[lastPlace].id) == nil
              && starter.nodes.allSatisfy { node in narrowed.index(of: node.id).map { narrowed.nodes[$0].id == node.id } ?? true }
              && narrowed.index(of: "hub:d1").map { narrowed.nodes[$0].role == .hub } == true
              && narrowed.index(of: nil) == nil,
              "a node in focus is found again by its id after the network is redrawn, not by where it was")
        check(layout.labelledFiles(limit: 1).count == 1, "only the busiest file labels are drawn")

        let ordered = RanchOrder.lastEdited.sorted(overview.directories)
        check(names(RanchPins.ordered(ordered, pinned: ["d1"])) == ["Finance", "Models", "Outlook"]
              && names(RanchPins.ordered(ordered, pinned: ["d1", "d3"])) == ["Finance", "Outlook", "Models"]
              && names(RanchPins.ordered(ordered, pinned: [])) == names(ordered),
              "pinned directories go first, in the chosen order among themselves, and the rest keep theirs")
        let pinDefaults = MemoryDirectoryDefaults(suiteName: nil)!
        RanchPins.save(["d2", "d1"], defaults: pinDefaults)
        check(RanchPins.saved(defaults: pinDefaults) == ["d1", "d2"] && RanchPins.saved(defaults: MemoryDirectoryDefaults(suiteName: nil)!).isEmpty,
              "pins are remembered between launches, and none are pinned at first")

        var trail = RanchNetworkTrail()
        check(!trail.canGoBack && trail.back() == nil, "the whole network has nothing to go back to")
        trail.leave(nil, for: "d1")
        trail.leave("d1", for: "d1")
        trail.leave("d1", for: "d2")
        check(trail.visited == [nil, "d1"] && trail.canGoBack, "each click into another directory is retraced, staying put is not")
        check(trail.back() == "d1" && trail.back() == nil && !trail.canGoBack,
              "Back returns to the directory before, then to every directory")
        for index in 0..<60 { trail.leave("d\(index)", for: "d\(index + 1)") }
        check(trail.visited.count == 50 && trail.visited.last == "d59", "the trail keeps the latest fifty steps")
        check(overview.sources.filter(RanchKindFilter.spreadsheets.includes).count == 4
              && overview.sources.filter(RanchKindFilter.models.includes).isEmpty
              && overview.sources.filter(RanchKindFilter.all.includes).count == 4
              && Set(RanchKindFilter.allCases.map(\.title)).count == RanchKindFilter.allCases.count,
              "the kind filter keeps one kind of file, and All Kinds keeps every file")
    }

    // The sidebar's outline: folders before files, in name order, opened a level at a time.
    do {
        func file(_ id: String, _ path: String) -> RanchSource {
            RanchSource(id: id, directoryId: "d", path: path, name: (path as NSString).lastPathComponent, kind: "text", size: 1,
                        contentHash: nil, modifiedAt: nil, createdAt: nil, lastUsedAt: nil, counts: .none, activeShares: 0,
                        activity: 0)
        }
        let tree = RanchTree.make([file("1", "notes.md"), file("2", "transfer/b.csv"), file("3", "timecourse/run/a.csv"),
                                   file("4", "transfer/a.csv"), file("5", "Archive/old.txt")])
        let lines = { (rows: [RanchTree.Row]) in
            rows.map { row -> String in
                switch row {
                case .folder(_, let name, let depth): return "\(depth) \(name)/"
                case .file(let source, let depth): return "\(depth) \(source.name)"
                }
            }
        }
        check(lines(tree.rows { _ in false }) == ["1 Archive/", "1 timecourse/", "1 transfer/", "1 notes.md"],
              "a closed outline lists the directory's folders in name order, then the files at its top")
        check(lines(tree.rows { $0 == "transfer" || $0 == "timecourse" })
              == ["1 Archive/", "1 timecourse/", "2 run/", "1 transfer/", "2 b.csv", "2 a.csv", "1 notes.md"],
              "an open folder shows its folders, then its files in the order given, a level further in")
        let everything = tree.rows { _ in true }
        check(lines(everything).contains("3 a.csv") && RanchTree.make([]).isEmpty && !tree.isEmpty,
              "folders inside folders open in turn, and a directory with no files has no outline")
        check(Set(everything.map(\.id)).count == everything.count, "every line of the outline has an id of its own")
        check(RanchTree.key(directory: "d") == "d" && RanchTree.key(directory: "d", folder: "transfer/run") == "d/transfer/run",
              "an open directory or folder is remembered by its directory and path")
    }

    // Needs Review: each link's place in its source, and the sheet view that goes to it.
    do {
        check(RanchSheetColumns.letter(0) == "A" && RanchSheetColumns.letter(25) == "Z" && RanchSheetColumns.letter(26) == "AA"
              && RanchSheetColumns.letter(701) == "ZZ" && RanchSheetColumns.letter(702) == "AAA",
              "columns are lettered as spreadsheets letter them")
        let sheet = RanchSheet(name: "Accounting", columns: 4,
                               rows: [["REVENUES", "", "", ""], ["Supplies", "400", "", "310"], ["TOTAL", "47400", "", "37902"]],
                               rowNumbers: [9, 26, 27], truncated: false)
        let book = RanchWorkbook(sheets: [RanchSheet(name: "Notes", columns: 1, rows: [["x"]], rowNumbers: [1], truncated: false), sheet],
                                 skipped: [])
        let cited = book.place(of: RanchAnchor(kind: "table-cell", sheet: "Accounting", rowIndex: 1, columnIndex: 3, rowKey: "Supplies"))
        check(cited == RanchCellPlace(sheet: 1, sheetName: "Accounting", row: 1, column: 3, name: "D26"),
              "a link's cell is found on its sheet and named as the app names it")
        check(book.place(of: RanchAnchor(sheet: "Accounting", rowIndex: 0, columnIndex: 1, rowKey: "Supplies"))?.row == 1,
              "a row that moved since the link was made is found again by its label")
        check(book.place(of: RanchAnchor(sheet: "Gone", rowIndex: 0, columnIndex: 0)) == nil
              && book.place(of: RanchAnchor(kind: "pdf-page", pageNumber: 3)) == nil,
              "a sheet the workbook no longer has, or a place that is not a cell, is not guessed at")
        check(book.place(of: RanchAnchor(sheet: "Accounting", rowIndex: 2, columnIndex: 9))?.name == nil,
              "a link to a whole row shades the row and names no cell")

        let json = """
        {"id": "link:x", "kind": "changed", "title": "Linked value changed", "directoryId": "d", "path": "Budget.xlsx",
         "fileId": "f", "documents": ["Memo.docx"], "detail": "Changed.",
         "links": [{"id": "dep", "status": "STALE", "documentDirectoryId": "d", "documentPath": "Notes/Memo.docx",
                    "documentFileId": null, "text": "400", "label": "Supplies", "linkedValue": "400", "currentValue": "450",
                    "anchor": {"kind": "table-cell", "sheet": "Accounting", "rowIndex": "18", "columnIndex": 1, "elementId": 7},
                    "issue": null}]}
        """
        let item = try? JSONDecoder().decode(RanchReviewItem.self, from: Data(json.utf8))
        check(item?.links.first?.documentName == "Memo.docx" && item?.links.first?.currentValue == "450"
              && item?.links.first?.anchor == RanchAnchor(kind: "table-cell", sheet: "Accounting", columnIndex: 1),
              "an anchor field of an unexpected type is left out rather than failing the library")
        let older = try? JSONDecoder().decode(RanchReviewItem.self, from: Data("""
        {"id": "r", "kind": "unreadable", "title": "t", "directoryId": "d", "path": null, "fileId": null, "documents": [], "detail": "x"}
        """.utf8))
        check(older?.links == [], "an item from a server that sends no links still reads")

        let text = "first\nsecond\nthird"
        check(RanchCodeLines.range(ofLine: 2, in: text) == NSRange(location: 6, length: 7)
              && RanchCodeLines.range(ofLine: 3, in: text) == NSRange(location: 13, length: 5)
              && RanchCodeLines.range(ofLine: 99, in: text).location == 13,
              "a cited line is selected whole, and a line past the end selects the last")
    }

    let lookalikes = ["gsheet", "csv", "pdf", "gdoc", "gslides", "txt", "md", "json", "js", "step", "dxf", "png"]
    let styles = lookalikes.compactMap(RanchTypeIcon.style(for:))
    check(styles.count == lookalikes.count && Set(styles.map { "\($0.mark)" }).count == lookalikes.count,
          "every type macOS draws as a plain white page gets an icon of its own")
    check(RanchTypeIcon.style(for: "gsheet")?.mark == .sheet && RanchTypeIcon.style(for: "csv")?.mark == .label("CSV")
          && RanchTypeIcon.style(for: "gsheet")?.color != RanchTypeIcon.style(for: "csv")?.color
          && RanchTypeIcon.style(for: "pdf")?.mark == .label("PDF"),
          "a Google Sheet, a CSV and a PDF look different from each other")
    check(["xlsx", "docx", "pptx", "numbers", "pages", "key", "html", "zip"].allSatisfy { RanchTypeIcon.style(for: $0) == nil },
          "Excel, Word, PowerPoint, iWork, web pages and archives keep their apps' own icons")
    check(RanchTypeIcon.style(for: "PDF") == RanchTypeIcon.style(for: "pdf") && RanchTypeIcon.style(for: "jpeg")?.mark == .label("JPG")
          && RanchTypeIcon.style(for: "markdown")?.mark == .label("MD"),
          "type icons ignore case and shorten long extensions")
    func ink(_ fileExtension: String) -> Data? {
        guard let image = RanchTypeIcon.image(for: fileExtension, size: 20),
              let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 40, pixelsHigh: 40, bitsPerSample: 8, samplesPerPixel: 4,
                                         hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(x: 0, y: 0, width: 40, height: 40))
        NSGraphicsContext.restoreGraphicsState()
        return rep.tiffRepresentation
    }
    let blank = ink("xlsx")
    check(blank == nil && ink("pdf") != nil && ink("pdf") != ink("csv") && ink("gsheet") != ink("gdoc")
          && RanchTypeIcon.image(for: "pdf", size: 20) === RanchTypeIcon.image(for: "pdf", size: 20),
          "type icons draw differently from each other and are made once per size")

    func components(_ color: NSColor) -> (saturation: CGFloat, brightness: CGFloat) {
        let rgb = color.usingColorSpace(.deviceRGB) ?? color
        return (rgb.saturationComponent, rgb.brightnessComponent)
    }
    let grey = components(RanchActivityColor.color(for: 0)), green = components(RanchActivityColor.color(for: 1))
    check(grey.saturation < 0.01 && green.saturation > 0.6 && green.brightness > grey.brightness,
          "unused files are grey and the most used are bright green")
    check(components(RanchActivityColor.color(for: .nan)).saturation < 0.01
          && components(RanchActivityColor.color(for: 4)).saturation == green.saturation,
          "activity outside 0...1 is clamped")
    check(RanchViewerKind.choose(for: "STEP") == .wireframe && RanchViewerKind.choose(for: "stl") == .mesh
          && RanchViewerKind.choose(for: "dxf") == .plan && RanchViewerKind.choose(for: "xlsx") == .sheet
          && RanchViewerKind.choose(for: "XLS") == .sheet && RanchViewerKind.choose(for: "csv") == .quickLook,
          "models turn, drawings pan, and documents scroll in Quick Look")
    check(RanchViewerKind.choose(for: "PPTX") == .slides && RanchViewerKind.choose(for: "key") == .quickLook,
          "a PowerPoint deck shows its slides' pictures under a slide menu")
    let slideAnchor = try? JSONDecoder().decode(RanchAnchor.self, from: Data(#"{"kind":"text-excerpt","slideNumber":3}"#.utf8))
    check(slideAnchor?.slideNumber == 3, "a link into a deck names its slide")

    let codeJSON = """
    {"id": "c", "directoryId": "d1", "path": "src/server.js", "name": "server.js", "kind": "code", "fileType": "code",
     "size": 900, "contentHash": "h-c", "modifiedAt": null, "createdAt": null, "lastUsedAt": null,
     "counts": {"tabs": 0, "opens": 0, "visits": 0, "shares": 0, "references": 0}, "activeShares": 0, "activity": 0,
     "shareable": false}
    """
    let code = try! JSONDecoder().decode(RanchSource.self, from: Data(codeJSON.utf8))
    check(code.isCode && !code.canShareLink && RanchViewerKind.choose(for: code) == .code,
          "code shows numbered lines and offers no share link")
    let notesFile = try! JSONDecoder().decode(RanchSource.self, from: Data(codeJSON
        .replacingOccurrences(of: "src/server.js", with: "notes.md").replacingOccurrences(of: "server.js", with: "notes.md")
        .replacingOccurrences(of: "\"fileType\": \"code\"", with: "\"fileType\": \"markdown\"").utf8))
    check(RanchViewerKind.choose(for: notesFile) == .text, "notes show in the text viewer, which tints the passages their latest version changed")
    let older = try! JSONDecoder().decode(RanchSource.self, from: Data(codeJSON
        .replacingOccurrences(of: ",\n \"shareable\": false", with: "").replacingOccurrences(of: "\"fileType\": \"code\",", with: "").utf8))
    check(older.canShareLink && !older.isCode && RanchViewerKind.choose(for: older) == .quickLook,
          "a server that says neither keeps the file shareable and in Quick Look")
    let text = "one\ntwo\nthree\n"
    check(RanchCodeLines.lines(in: text, selection: NSRange(location: 4, length: 3)) == 2...2
          && RanchCodeLines.lines(in: text, selection: NSRange(location: 0, length: 8)) == 1...2
          && RanchCodeLines.lines(in: text, selection: NSRange(location: 2, length: 7)) == 1...3
          && RanchCodeLines.lines(in: text, selection: NSRange(location: 3, length: 0)) == nil,
          "a selection covers the lines it touches, not the line after its last line break")
    check(RanchCodeLines.label(4...4) == "Line 4" && RanchCodeLines.label(10...20) == "Lines 10\u{2013}20",
          "selected lines are named the way they are written")
}

// MARK: Recent Changes as an audit log

do {
    let json = """
    {"change": {"id": "c1", "change": "edited", "directoryId": "d1", "at": "2026-11-03T10:24:00.000Z", "source": "WATCHER",
     "actor": {"name": "Dana Walker", "type": "HUMAN_SELF"}, "initiatedBy": null, "request": null,
     "version": {"before": 12, "after": 13}, "path": "notes/field.md", "previousPath": null, "fileId": "f1", "fileCount": 1,
     "files": [], "file": {"type": "markdown", "before": {"size": 2048, "hash": "a"}, "after": {"size": 3072, "hash": "b"}},
     "lines": {"added": 1, "removed": 1, "truncated": false, "hunks": [{"lines": [
        {"kind": "same", "text": "Site visit on Monday.", "before": 3, "after": 3},
        {"kind": "remove", "text": "Soil was dry.", "before": 4, "after": null},
        {"kind": "add", "text": "Soil was damp after rain.", "before": null, "after": 4}]}]},
     "table": null, "fields": null, "values": [], "valueCount": 0, "movedCount": 0, "bytesReleased": false}}
    """
    let detail = try? RanchChangeDetail.decode(Data(json.utf8))
    check(detail?.lines?.hunks.first?.lines.count == 3 && detail?.at != nil && detail?.version.after == 13
          && detail?.listsChanges == true && detail?.isCode == false,
          "A change's detail decodes with its lines, versions and date")
    check(RanchChangeWords.version(RanchChangeDetail.Version(before: 12, after: 13)) == "12 \u{2192} 13"
          && RanchChangeWords.version(RanchChangeDetail.Version(before: nil, after: 1)) == "1",
          "A change names the directory versions it went between")

    let lines = detail?.lines?.hunks.first?.lines ?? []
    let marks = RanchChangeWords.changedWords(in: lines)
    let marked = { (index: Int) in (marks[index] ?? []).map { (lines[index].text as NSString).substring(with: $0) } }
    check(marks[0] == nil && marked(1) == ["dry"] && marked(2) == ["damp after rain"],
          "A rewritten line marks the words it dropped and the words its replacement brought, a phrase as one mark")
    let rewritten = [RanchChangeDetail.Line(kind: "remove", text: "Old words here", before: 1, after: nil),
                     RanchChangeDetail.Line(kind: "add", text: "Entirely different text", before: nil, after: 1)]
    check(RanchChangeWords.changedWords(in: rewritten).isEmpty, "A line rewritten whole is left to its colour")

    check(RanchChangeWords.who(RanchActor(name: "Lasso", type: "SYSTEM"), source: "WATCHER") == .disk
          && RanchChangeWords.who(RanchActor(name: "Lasso", type: "SYSTEM"), source: "REINDEX") == .lasso
          && RanchChangeWords.who(RanchActor(name: "Claude Code", type: "AI_AGENT"), source: "AGENT_EDIT") == .agent("Claude Code")
          && RanchChangeWords.who(RanchActor(name: "Dana Walker", type: "HUMAN_SELF"), source: "WATCHER").title == "Dana Walker",
          "A save Lasso only saw on disk is never credited to Lasso")
    check(RanchChangeWords.recorded("WATCHER") == "Saved on this Mac" && RanchChangeWords.recorded("SOME_NEW_SOURCE") == "Some new source",
          "How a change was recorded reads as words, even for a source the app does not know yet")
    let kb = { (bytes: Int) in ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file) }
    check(RanchChangeWords.size(before: 2048, after: 3072) == "\(kb(2048)) \u{2192} \(kb(3072))"
          && RanchChangeWords.size(before: 2048, after: 2048) == "\(kb(2048)), unchanged"
          && RanchChangeWords.size(before: 2048, after: nil) == "\(kb(2048)) when removed"
          && RanchChangeWords.size(before: nil, after: nil) == nil,
          "A change's size says what it was and what it became")
    check(RanchChangeWords.row("row:4") == "Row 4" && RanchChangeWords.row("Ada") == "Ada"
          && RanchChangeWords.lineSummary(RanchChangeDetail.Lines(added: 2, removed: 1, hunks: [], truncated: false)) == "2 lines added, 1 removed",
          "Table rows and line counts read as words")
    check(RanchChangeWords.textSummary(RanchTextChanges(added: 1, removed: 0, unit: "line")) == "1 line added"
          && RanchChangeWords.textSummary(RanchTextChanges(added: 2, removed: 1, unit: "paragraph")) == "2 paragraphs added, 1 removed",
          "A text file's row says how many lines or paragraphs its save changed")
    var passage = RanchHistoryEntry(id: "p", directoryId: "d1", at: nil, change: "edited", path: "todo.txt", previousPath: nil,
                                    fileId: nil, fileCount: nil)
    passage.valueChanges = RanchValueChanges(count: 1, first: .init(label: "todo", before: "Order rebar\nCall the surveyor",
                                                                      after: "Order rebar\nCall the surveyor\nBook the crane"))
    check(passage.valueCaption(directory: "Site") == "1 value changed \u{00B7} Site",
          "A passage is counted rather than quoted, since a row has no room for its lines")
}

// MARK: Recent Changes holds still until new changes are taken in

do {
    func entry(_ id: String) -> RanchHistoryEntry {
        RanchHistoryEntry(id: id, directoryId: "d1", at: nil, change: "edited", path: "\(id).md", previousPath: nil,
                          fileId: nil, fileCount: nil)
    }
    var feed = RanchChangeFeed()
    let first = [entry("b"), entry("a")]
    check(feed.shown(first).map(\.id) == ["b", "a"] && feed.waiting(first).isEmpty,
          "Before the library is read, nothing waits behind the pill")
    feed.begin(with: first)
    let later = [entry("d"), entry("c"), entry("b"), entry("a")]
    check(feed.shown(later).map(\.id) == ["b", "a"] && feed.waiting(later).map(\.id) == ["d", "c"],
          "Changes that arrive later wait behind the pill, and the list holds still")
    feed.begin(with: later)
    check(feed.waiting(later).count == 2, "A later read does not take them in by itself")
    let aged = [entry("d"), entry("c"), entry("b")]
    check(feed.shown(aged).map(\.id) == ["b"], "A change that ages out of the two weeks leaves the list at once")
    feed.takeIn(aged)
    check(feed.shown(aged).map(\.id) == ["d", "c", "b"] && feed.waiting(aged).isEmpty,
          "Clicking the pill or pulling the list takes every waiting change in")
    check(RanchChangeFeed.pillTitle(1) == "1 new change" && RanchChangeFeed.pillTitle(3) == "3 new changes",
          "The pill counts the changes waiting")
}

// MARK: The glass card's outline

do {
    let rect = CGRect(x: 0, y: 0, width: 300, height: 112)
    func outline(pointerX: CGFloat, atTop: Bool) -> Path {
        AssistBubbleShape(geometry: AssistBubbleGeometry(cornerRadius: 18, pointerWidth: 21, pointerHeight: 12,
                                                         pointerX: pointerX, pointerAtTop: atTop)).path(in: rect)
    }
    let above = outline(pointerX: 84, atTop: true)
    check(above.contains(CGPoint(x: 84, y: 4)) && !above.contains(CGPoint(x: 60, y: 4)),
          "a glass card below the caret points up at it from its top edge")
    check(above.contains(CGPoint(x: 150, y: 60)) && !above.contains(CGPoint(x: 150, y: 4)),
          "the glass outline covers the card's body and nothing past it")
    let below = outline(pointerX: 84, atTop: false)
    check(below.contains(CGPoint(x: 84, y: 108)) && !below.contains(CGPoint(x: 60, y: 108)),
          "a glass card above the caret points down at it from its bottom edge")
    let nearEdge = outline(pointerX: 2, atTop: true)
    check(nearEdge.contains(CGPoint(x: 28.5, y: 4)) && !nearEdge.contains(CGPoint(x: 4, y: 4)),
          "an arrow near the card's edge stays clear of the rounded corner")
}

// MARK: Linked words drawn as pills

do {
    let font = NSFont(name: "Helvetica Neue", size: 15) ?? NSFont.systemFont(ofSize: 15)
    let style = HostTextStyle(fontName: font.fontName, fontFamily: font.familyName, fontSize: 15)
    let area = "18,400 sq ft"
    let areaWidth = ReferenceChipLayout.width(area, font)
    let drawn = ReferenceChipLayout.lines(text: area, fragments: [CGRect(x: 100, y: 200, width: areaWidth, height: 18)],
                                          style: style)
    check(drawn?.count == 1 && abs((drawn?[0].stretch ?? 0) - 1) < 0.001 && abs((drawn?[0].font.pointSize ?? 0) - 15) < 0.01,
          "a phrase in the host's own font is drawn again at its size, unstretched")
    let zoomed = ReferenceChipLayout.lines(text: area, fragments: [CGRect(x: 100, y: 200, width: areaWidth * 1.2, height: 22)],
                                           style: style)
    check(zoomed.map { abs($0[0].font.pointSize - 18) < 0.01 } == true, "a zoomed host's words are drawn at the size they show at")
    check(ReferenceChipLayout.lines(text: area, fragments: [CGRect(x: 100, y: 200, width: areaWidth * 2, height: 18)],
                                    style: style) == nil,
          "words that cannot match where the host drew them keep the host's own letters")
    check(ReferenceChipLayout.lines(text: "two\nparagraphs", fragments: [CGRect(x: 0, y: 0, width: 80, height: 18)],
                                    style: style) == nil,
          "words across paragraphs keep the host's own letters")

    // The Claude app's message box answered a header's bounds with its whole
    // multi-line field, and "Supplier" was drawn about 160 points tall over it.
    let wholeField = CGRect(x: 60, y: 300, width: 650, height: 165)
    check(DependencyGeometry.drawable([wholeField], referenceId: "supplier", fontSize: nil, caret: nil) == nil,
          "a whole field's frame given for a word draws no pill, even where the host states no size or caret")
    check(DependencyGeometry.drawable([wholeField], referenceId: "supplier", fontSize: 16, caret: nil) == nil
          && DependencyGeometry.drawable([wholeField], referenceId: "supplier", fontSize: nil,
                                         caret: CGRect(x: 80, y: 310, width: 0, height: 19)) == nil,
          "a whole field's frame draws no pill beside a stated size or a measured caret")
    let twoLines = CGRect(x: 60, y: 300, width: 300, height: 40)
    check(DependencyGeometry.drawable([twoLines], referenceId: "supplier", fontSize: 16, caret: nil) == nil
          && DependencyGeometry.drawable([twoLines], referenceId: "supplier", fontSize: nil,
                                         caret: CGRect(x: 80, y: 310, width: 0, height: 19)) == nil,
          "a paragraph's two lines given as one rectangle draw no pill")
    let supplierLine = CGRect(x: 60, y: 300, width: ReferenceChipLayout.width("Supplier", font), height: 24)
    check(DependencyGeometry.drawable([supplierLine], referenceId: "supplier", fontSize: 15, caret: nil)?.fragments
          == [supplierLine]
          && DependencyGeometry.drawable([supplierLine], referenceId: "supplier", fontSize: nil,
                                         caret: CGRect(x: 80, y: 300, width: 0, height: 17))?.fragments == [supplierLine]
          && DependencyGeometry.drawable([supplierLine], referenceId: "supplier", fontSize: nil, caret: nil) != nil,
          "a word's own line with generous spacing is drawn")
    check(DependencyGeometry.drawable([CGRect(x: 60, y: 300, width: 400, height: 88)], referenceId: "title",
                                      fontSize: 72, caret: nil) != nil,
          "a large title's line is drawn when the host states its size")
    if let line = DependencyGeometry.drawable([supplierLine], referenceId: "supplier", fontSize: nil, caret: nil),
       let drawnLine = ReferenceChipLayout.lines(text: "Supplier", fragments: line.fragments, style: nil)?.first {
        check(drawnLine.textHeight <= supplierLine.height + 1, "a drawn pill's words stay within their line")
    }

    let first = "the retaining wall needs a second", second = "inspection before the pour"
    let wrapped = ReferenceChipLayout.lines(text: first + " " + second, fragments: [
        CGRect(x: 300, y: 400, width: ReferenceChipLayout.width(first, font), height: 18),
        CGRect(x: 40, y: 382, width: ReferenceChipLayout.width(second, font), height: 18),
    ], style: style)
    check(wrapped?.map(\.text) == [first, second], "a wrapped phrase is split where the host wrapped it")
    check(wrapped.map { $0[0].baseline > $0[1].baseline } == true, "each line is drawn on its own baseline")

    func chip(_ phrase: String, roomAfter: Bool = true) -> OverlayChip? {
        let fragments = [CGRect(x: 100, y: 200, width: ReferenceChipLayout.width(phrase, font), height: 18)]
        guard let lines = ReferenceChipLayout.lines(text: phrase, fragments: fragments, style: style) else { return nil }
        return OverlayChip(id: phrase, text: phrase, fragments: fragments, lines: lines, state: .healthy, tint: .systemGreen,
                           page: .white, ink: .black, words: .systemGreen, sourcePath: "Area Schedule.xlsx",
                           roomBefore: true, roomAfter: roomAfter, badgeSide: ChipBadgeSide.choose(lines: lines), isNew: false)
    }
    let space = ReferenceChipLayout.width(" ", font)
    if let income = chip("income tax expense") {
        let pill = income.pill(0), words = income.fragments[0]
        check(pill.minX > words.minX - space * 0.5 && pill.maxX < words.maxX + space * 0.5,
              "a pill reaches less than half way into the spaces beside its words")
        check(income.badgeSide == .after, "the type icon sits over the phrase's own low letters at its end")
        check(income.badge.map { $0.minX >= pill.minX && $0.maxX <= pill.maxX } == true,
              "the type icon stays within the pill, off the letters of the words beside it")
        check(income.badge.map { $0.minY > income.lines![0].baseline + income.lines![0].font.xHeight } == true,
              "it sits clear of the tops of the lowercase letters under it")
    } else {
        check(false, "a phrase in the host's font is drawn again")
    }
    check(chip("expense,", roomAfter: false).map { abs($0.pill(0).maxX - $0.fragments[0].maxX) < 0.001 } == true,
          "a pill stops at its words where punctuation follows them")
    check(chip("measured Total")?.badgeSide == .before, "with tall letters at its end the icon sits over low ones at its start")
    check(chip(area).map { $0.badgeSide == nil && $0.badge == nil } == true,
          "with tall letters at both ends no icon is drawn over the text, and the menu shows the type")
    check(ChipBadgeSide.choose(lines: nil) == nil, "words left in the host's letters get no icon over them")

    check(ReferenceChipPalette.isDark(HostTextStyle(foreground: NSColor(white: 0.92, alpha: 1)), systemDark: false),
          "light words mean a dark page")
    check(!ReferenceChipPalette.isDark(HostTextStyle(foreground: NSColor(white: 0.1, alpha: 1)), systemDark: true),
          "dark words mean a light page, whatever the system's appearance")
    check(ReferenceChipPalette.isDark(nil, systemDark: true) && !ReferenceChipPalette.isDark(nil, systemDark: false),
          "without the host's colours the system's appearance decides")

    let line = CGRect(x: 100, y: 500, width: 1, height: 18)
    let after = DependencyGeometry(referenceId: "a", fragments: [CGRect(x: 160, y: 500, width: 40, height: 18)])
    let before = DependencyGeometry(referenceId: "b", fragments: [CGRect(x: 20, y: 500, width: 40, height: 18)])
    let below = DependencyGeometry(referenceId: "c", fragments: [CGRect(x: 20, y: 482, width: 40, height: 18)])
    let above = DependencyGeometry(referenceId: "d", fragments: [CGRect(x: 20, y: 518, width: 40, height: 18)])
    check(after.mayMove(typingAt: line) && below.mayMove(typingAt: line),
          "typing moves the phrases after the caret on its line and on the lines below")
    check(!before.mayMove(typingAt: line) && !above.mayMove(typingAt: line),
          "words just accepted before the caret, and lines above, stay drawn while typing goes on")
    let inside = DependencyGeometry(referenceId: "e", fragments: [CGRect(x: 60, y: 500, width: 80, height: 18)])
    let touching = DependencyGeometry(referenceId: "f", fragments: [CGRect(x: 60, y: 500, width: 40, height: 18)])
    check(inside.mayMove(typingAt: line) && touching.mayMove(typingAt: line),
          "typing inside or immediately at the end of a phrase quiets it")
    check(before.mayMove(deletingAt: line) && touching.mayMove(deletingAt: line)
          && after.mayMove(deletingAt: line) && below.mayMove(deletingAt: line),
          "deleting quiets phrases anywhere on the caret line and on lines below")
    check(!above.mayMove(deletingAt: line),
          "deleting on a later line leaves phrases strictly above it untouched")

    let overlay = OverlayView(frame: NSRect(x: 0, y: 0, width: 300, height: 100))
    let chip = OverlayChip(id: "c1", text: "Invoice", fragments: [CGRect(x: 20, y: 20, width: 60, height: 18)],
                           lines: nil, state: .healthy, tint: .systemBlue, page: .white, ink: .black,
                           words: .systemBlue, sourcePath: "sheet.xlsx", roomBefore: true, roomAfter: true,
                           badgeSide: nil, isNew: false)
    overlay.show([chip])
    check(overlay.hasContent && overlay.paintedBounds != nil, "overlay holds a shown phrase")
    overlay.clear()
    check(!overlay.hasContent && overlay.paintedBounds == nil, "clearing the overlay drops every phrase immediately")

    var keys = HighlightKeyTracker()
    check(keys.key(keyCode: 0, command: true, shift: false) == .ignore && keys.mayHaveSelection,
          "Command-A marks a pending selection")
    check(keys.key(keyCode: 51, command: false, shift: false) == .quietAll && !keys.mayHaveSelection,
          "Backspace after Command-A quiets every visible phrase at once")
    check(keys.key(keyCode: 51, command: false, shift: false) == .quietDeleting,
          "plain Backspace quiets phrases on the caret line and below")
    check(keys.key(keyCode: 51, command: true, shift: false) == .quietAll,
          "Command-Backspace quiets every visible phrase")
    check(keys.key(keyCode: 7, command: true, shift: false) == .quietAll
          && keys.key(keyCode: 6, command: true, shift: false) == .quietAll
          && keys.key(keyCode: 9, command: true, shift: false) == .quietAll,
          "Cut, Undo and Paste quiet every visible phrase")
    check(keys.key(keyCode: 36, command: false, shift: false) == .quietTyping(immediate: true),
          "Return schedules an immediate refresh so sent chat messages clear their highlights")
    check(keys.key(keyCode: 123, command: false, shift: true) == .ignore && keys.mayHaveSelection,
          "Shift-arrow marks a selection")
    check(keys.key(keyCode: 123, command: false, shift: false) == .ignore && !keys.mayHaveSelection,
          "an unshifted arrow clears the selection mark")
    keys.mouseDragged()
    check(keys.key(keyCode: 14, command: false, shift: false) == .quietAll,
          "typing over a mouse-dragged selection quiets every visible phrase")
}

// MARK: Change Source

do {
    func offered(_ text: String, _ object: String, path: String = "Area Schedule.xlsx") -> ReferenceAlternative {
        ReferenceAlternative(text: text, label: text, detail: "", path: path, location: "", objectId: object,
                             versionId: nil, snapshotId: nil, projectId: "p", usageObjectId: nil)
    }
    let list = ReferenceAlternative.offered(accepted: offered("18,400 sq ft", "a"),
                                            others: [offered("18,400 sq ft", "a"), offered("17,950 sq ft", "b"),
                                                     offered("18,250 sq ft", "c", path: "Planning.pdf")])
    check(list.map(\.objectId) == ["a", "b", "c"], "the accepted source comes first, then the card's others, each once")
    check(ReferenceAlternative.offered(accepted: offered("x", "a"), others: (0..<12).map { offered("v\($0)", "o\($0)") })
            .count == ReferenceAlternative.limit, "only as many sources are kept as the card shows")
    let picked = ReferenceAlternative.offered(accepted: offered("\u{201C}a second inspection\u{201D} (p. 4)", "a"),
                                              others: [offered("the wall needs a second inspection", "a"), offered("x", "b")],
                                              samePassage: true)
    check(picked.map(\.objectId) == ["a", "b"], "words picked from a passage stand for that passage")

    var reference = DependencyReference(
        id: "r", objectId: "b", versionId: nil, hostBundleIdentifier: "x", hostApplication: "x", documentContext: "d",
        anchor: TextAnchor(text: "17,950 sq ft", prefixContext: "", suffixContext: "", approximateOffset: 0),
        state: .healthy, label: "", valueText: nil, sourcePath: "Area Schedule.xlsx", sourceLocation: "",
        alternatives: list, createdAt: Date(), updatedAt: Date())
    check(reference.currentAlternativeIndex == 1 && reference.otherAlternatives.map(\.objectId) == ["a", "c"],
          "after a change the source in use is found among those offered, and the rest are offered")
    reference.shareToken = "t"
    check(reference.otherAlternatives.isEmpty, "a share link's words keep the source the link was made for")
    reference.shareToken = nil
    reference.alternatives = nil
    check(reference.otherAlternatives.isEmpty && reference.currentAlternativeIndex == nil,
          "links saved before sources were kept offer no change")
    let encoded = try? JSONEncoder().encode([reference])
    let older = encoded.flatMap { String(data: $0, encoding: .utf8) }?.replacingOccurrences(of: ",\"alternatives\":null", with: "")
    check(older.flatMap { try? JSONDecoder().decode([DependencyReference].self, from: Data($0.utf8)) }?.count == 1,
          "links saved by older builds still load")

    let gross = offered("Gross Floor Area", "a"), net = offered("Net Floor Area", "b")
    check(ReferenceSwap.words(for: net, current: gross, shown: "gross floor area", before: "the ") == "net floor area",
          "a source lowered to fit the sentence passes that on to the one chosen instead")
    check(ReferenceSwap.words(for: net, current: gross, shown: "Gross Floor Area", before: "the ") == "Net Floor Area",
          "a source inserted as its file spells it is replaced as the new file spells it")
    var code = offered("rangeStart", "c")
    code.verbatim = true
    check(ReferenceSwap.words(for: code, current: gross, shown: "gross floor area", before: "the ") == "rangeStart",
          "code keeps its letters")
    let document = Array("the area is 18,400 sq ft, and".utf16)
    check(String(decoding: ReferenceSwap.expected(document, replacing: 12..<24, with: "17,950 sq ft (net)"), as: UTF16.self)
            == "the area is 17,950 sq ft (net), and",
          "only the phrase's own characters are written over")
}

// MARK: Apps Lasso suggests in

do {
    let suite = "lasso-tests-suggestion-apps-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let apps = SuggestionApps(defaults: defaults, ownBundleID: "com.jte700.lasso", limit: 3)

    check(apps.allows("com.apple.Notes") && apps.listed.isEmpty, "every app gets suggestions until one is switched off")

    apps.noteTyping(in: "com.apple.Notes")
    apps.noteTyping(in: "com.apple.mail")
    apps.noteTyping(in: "com.apple.Notes")
    check(apps.listed == ["com.apple.Notes", "com.apple.mail"], "an app typed in is listed once, in the order first seen")

    apps.noteTyping(in: "com.jte700.lasso")
    check(!apps.listed.contains("com.jte700.lasso"), "Lasso does not list itself")

    apps.setAllowed(false, for: "com.tinyspeck.slackmacgap")
    check(!apps.allows("com.tinyspeck.slackmacgap") && apps.listed.last == "com.tinyspeck.slackmacgap",
          "an app switched off before it was typed in is listed and gets no suggestions")
    check(apps.allows("com.apple.Notes"), "switching one app off leaves the others on")

    apps.setAllowed(true, for: "com.tinyspeck.slackmacgap")
    check(apps.allows("com.tinyspeck.slackmacgap") && apps.listed.contains("com.tinyspeck.slackmacgap"),
          "switching an app back on keeps it in the list")

    apps.setAllowed(false, for: "com.apple.Notes")
    apps.noteTyping(in: "com.microsoft.Word")
    apps.noteTyping(in: "com.apple.Safari")
    check(apps.listed.count <= 4 && apps.listed.contains("com.apple.Notes") && !apps.allows("com.apple.Notes"),
          "the list forgets the oldest apps typed in, never one that is switched off")
    check(apps.listed.contains("com.apple.Safari"), "the newest app typed in is kept")

    let reread = SuggestionApps(defaults: defaults, ownBundleID: "com.jte700.lasso", limit: 3)
    check(!reread.allows("com.apple.Notes") && reread.listed == apps.listed, "choices survive a restart")
    apps.noteTyping(in: "")
    check(!apps.listed.contains(""), "an app with no bundle identifier is not listed")
}

// A suggested value's recent change is named in the row's dim detail slot.
do {
    let edited = AssistValueChange(json: ["kind": "edited", "previousValue": "18,400", "currentValue": "19,250",
                                          "changedAt": "2026-11-10T12:00:00Z", "snapshotId": "s1"])
    check(edited?.detail(replacing: "19,250") == "19,250 · was 18,400", "an edited value reads as its value and what it was")
    check(edited?.detail(replacing: "") == "19,250 · was 18,400", "an empty detail still shows the current value")
    let stale = AssistValueChange(json: ["kind": "stale-typed", "previousValue": "18,400", "currentValue": "19,250"])
    check(stale?.detail(replacing: "19,250") == "changed from 18,400", "a typed earlier value reads as changed from it")
    let recalculated = AssistValueChange(json: ["kind": "recalculated", "previousValue": "3", "currentValue": "4"])
    check(recalculated?.detail(replacing: "4") == "4 · was 3", "a recalculated value reads like an edited one")
    check(AssistValueChange(json: ["kind": "renamed", "previousValue": "a", "currentValue": "b"]) == nil,
          "an unknown kind of change is ignored")
    check(AssistValueChange(json: nil) == nil && AssistValueChange(json: ["kind": "edited"]) == nil,
          "a suggestion without a change, or with an incomplete one, has none")
    let sheet = AssistValueChange(json: ["kind": "edited", "previousValue": "18400", "currentValue": "19250",
                                         "previousDisplay": "18,400", "currentDisplay": "19,250"])
    check(sheet?.detail(replacing: "19250") == "19,250 · was 18,400", "a worksheet value reads as the sheet formats it")
    let typedSheet = AssistValueChange(json: ["kind": "stale-typed", "previousValue": "18400", "currentValue": "19250", "previousDisplay": "18,400"])
    check(typedSheet?.detail(replacing: "19250") == "changed from 18,400", "so does a typed earlier worksheet value")
    let written = AssistValueChange(json: ["kind": "edited", "previousValue": "18400", "currentValue": "19250"])
    check(written?.detail(replacing: "19250") == "19250 · was 18400", "a CSV value reads as written")
}

// The Ranch's Recent Changes name the value an edit changed.
do {
    func entry(_ json: String) -> RanchHistoryEntry? {
        try? JSONDecoder().decode(RanchHistoryEntry.self, from: Data(json.utf8))
    }
    let one = entry(#"{"id":"c1","directoryId":"d","change":"edited","path":"budget.xlsx","valueChanges":{"count":1,"first":{"label":"Q3 Total","before":"18,400","after":"19,250"}}}"#)
    check(one?.valueCaption(directory: "Finance") == "Q3 Total 18,400 \u{2192} 19,250", "one changed value reads as its label, old and new value")
    let several = entry(#"{"id":"c2","directoryId":"d","change":"edited","path":"budget.xlsx","valueChanges":{"count":4,"first":{"label":"Q3 Total","before":"1","after":"2"}}}"#)
    check(several?.valueCaption(directory: "Finance") == "4 values changed \u{00B7} Finance", "several changed values are counted")
    let formatted = entry(#"{"id":"c4","directoryId":"d","change":"edited","path":"budget.xlsx","valueChanges":{"count":1,"first":{"label":"Payroll","before":"18400","after":"19250","beforeDisplay":"18,400","afterDisplay":"19,250"}}}"#)
    check(formatted?.valueCaption(directory: "Finance") == "Payroll 18,400 \u{2192} 19,250", "a worksheet value's caption reads as the sheet formats it")
    let plain = entry(#"{"id":"c3","directoryId":"d","change":"edited","path":"notes.md"}"#)
    check(plain != nil && plain?.valueCaption(directory: "Finance") == nil, "an edit from an older server, or with no value changes, keeps its caption")
    let typedOne = entry(#"{"id":"c5","directoryId":"d","change":"edited","path":"Income.xls","valueChanges":{"count":10,"recalculated":9,"first":{"label":"Product 1 · Current Period","before":"4000","after":"5000"}}}"#)
    check(typedOne?.valueCaption(directory: "Accounting") == "Product 1 \u{00B7} Current Period 4000 \u{2192} 5000",
          "the one value typed into leads the caption; the formula cells it recalculated are left to the detail")
    let typedThree = entry(#"{"id":"c6","directoryId":"d","change":"edited","path":"Income.xls","valueChanges":{"count":12,"recalculated":9,"first":{"label":"Rent","before":"1","after":"2"}}}"#)
    check(typedThree?.valueCaption(directory: "Accounting") == "3 values changed \u{00B7} Accounting", "only values typed into are counted")
    let formulasOnly = entry(#"{"id":"c7","directoryId":"d","change":"edited","path":"Income.xls","valueChanges":{"count":4,"recalculated":4,"first":{"label":"Net","before":"1","after":"2"}}}"#)
    check(formulasOnly?.valueCaption(directory: "Accounting") == "4 values recalculated \u{00B7} Accounting", "a save that changed only formula results says so")
}

// A change's detail counts the values typed into apart from the formula cells that followed them.
do {
    func detail(_ values: String, count: Int, recalculated: Int) -> RanchChangeDetail? {
        try? RanchChangeDetail.decode(Data(#"{"change":{"id":"f1","change":"edited","directoryId":"d","source":"WATCHER","actor":{"name":"Lasso","type":"SYSTEM"},"version":{"before":1,"after":2},"path":"Income.xls","previousPath":null,"fileId":"x","fileCount":1,"files":[],"file":null,"lines":null,"table":null,"fields":null,"values":[\#(values)],"valueCount":\#(count),"recalculatedCount":\#(recalculated),"movedCount":0,"bytesReleased":false}}"#.utf8))
    }
    let typed = #"{"kind":"modified","label":"Product 1","place":"Accounting!B18","before":"4000","after":"5000"}"#
    let formula = #"{"kind":"modified","label":"Net","place":"Accounting!B69","before":"6236","after":"5236","recalculated":true}"#
    let mixed = detail([typed, formula, formula].joined(separator: ","), count: 3, recalculated: 2)
    check(mixed?.values.map(\.isRecalculated) == [false, true, true], "a value says whether a formula recalculated it")
    check(mixed.map(RanchChangeWords.valueSummary) == "1 value changed \u{00B7} 2 recalculated", "the caption counts each apart")
    check(RanchChangeWords.recalculatedFold(9, typed: 1) == "9 formula cells recalculated from it", "the fold names what followed the typed value")
    check(RanchChangeWords.recalculatedFold(1, typed: 2) == "1 formula cell recalculated from them", "and from several")
    let onlyFormulas = detail(formula, count: 1, recalculated: 1)
    check(onlyFormulas.map(RanchChangeWords.valueSummary) == "1 value recalculated", "a save that changed only formula results says so")
    let older = detail(typed, count: 1, recalculated: 0)
    check(older.map(RanchChangeWords.valueSummary) == "1 value changed", "a value typed into alone reads as before")
}

// A folder's review card says who changed what since it was last approved, and how each conversation ended.
do {
    let dana = RanchReviewActor(id: "human:dana", name: "Dana Walker", type: "HUMAN_SELF")
    let me = RanchReviewActor(id: RanchReviewActor.meID, name: "Desktop", type: "HUMAN_SELF")
    let chatgpt = RanchReviewActor(id: "agent:chatgpt", name: "ChatGPT", type: "AI_AGENT")
    check(RanchReviewWords.names([dana, me, chatgpt]) == "Dana Walker, you and ChatGPT", "this Mac's person is \u{201C}you\u{201D} after a name")
    check(RanchReviewWords.names([me, dana]) == "You and Dana Walker", "and \u{201C}You\u{201D} leading")
    check(RanchReviewWords.names([dana, me, chatgpt, RanchReviewActor(id: "human:sam", name: "Sam", type: "HUMAN_SELF")]) == "Dana Walker, you and 2 others",
          "four or more are counted")
    check(RanchReviewWords.isPrompt("  \\ cap it at 15 minutes") && !RanchReviewWords.isPrompt("Ship it"), "a backslash first hands the words to the AI")

    let json = #"{"review":{"directoryId":"d","name":"Accounting","state":"approved","base":{"version":3,"at":"2026-11-12T10:00:00.000Z","approvedBy":{"id":"human:desktop","name":"Desktop","type":"HUMAN_SELF"}},"current":{"version":6,"at":"2026-11-18T10:00:00.000Z"},"saves":3,"people":[{"id":"human:dana","name":"Dana Walker","type":"HUMAN_SELF"}],"pendingComments":0,"approval":{"id":"a1","at":"2026-11-18T10:05:00.000Z","by":{"id":"human:desktop","name":"Desktop","type":"HUMAN_SELF"},"comments":1},"files":[{"path":"Income.xlsx","previousPath":null,"fileId":"f","fileType":"spreadsheet","change":"edited","kind":"sheet","viewed":true,"comments":2,"openThreads":0,"editors":[]},{"path":"notes.md","previousPath":null,"fileId":"g","fileType":"markdown","change":"added","kind":"lines","viewed":false,"comments":0,"openThreads":0,"editors":[]}],"moreFiles":0}}"#
    let review = try? RanchReview.decode(Data(json.utf8))
    let noon = ISO8601DateFormatter().date(from: "2026-11-18T12:00:00Z")!
    check(review.map { RanchReviewWords.headline($0, now: noon) } == "Dana Walker edited 2 files since you approved Nov 12", "the headline names who, how much and since when")
    let asked = try? RanchReview.decode(Data(json.replacingOccurrences(of: #""pendingComments":0"#, with: #""pendingComments":0,"requests":2"#).utf8))
    check(asked.map { RanchReviewWords.headline($0, now: noon) } == "2 changes requested", "a review of requests alone says so")
    check(RanchReviewWords.change("unchanged") == "Change requested", "a file only asked to change says so")
    check(RanchReviewWords.change("review") == "To review", "a file in a review asked for by name is there to be looked at")
    let named = try? RanchReview.decode(Data(json.replacingOccurrences(of: #""pendingComments":0"#, with: #""pendingComments":0,"requestId":"r1","number":3,"title":"Check the hours","reviewers":[{"name":"Dana Kim","email":"dana@studio.co"},{"name":"Sam Lee","email":"sam@acme.io"}],"requestedBy":{"id":"human:desktop","name":"Desktop","type":"HUMAN_SELF"}"#).utf8))
    check(named.map { RanchReviewWords.headline($0, now: noon) } == "You asked Dana Kim and Sam Lee to review 2 files in Accounting",
          "a review asked for by name says who was asked to look at what")
    check(RanchInvitee(email: " Dana.Kim@Studio.co").name == "Dana Kim" && RanchInvitee(email: "sam@acme.io", name: "Sam Lee").name == "Sam Lee",
          "a reviewer is named from their address unless a name is given")
    check(RanchInvitee.isAddress("nour@acme.io") && !RanchInvitee.isAddress("nour@acme"), "an address needs a domain with a dot")
    check(review.map(RanchReviewWords.viewed) == "1/2 viewed", "files looked at are counted")
    check(review?.approval.map { RanchReviewWords.approved($0).lead + " " + RanchReviewWords.approved($0).rest } == "You approved these changes with 1 comment",
          "the banner says who approved and what it sent")
    check(RanchReviewWords.sheetCounts(.init(cells: 3, recalculated: 2, rowsAdded: 1, rowsRemoved: 0)) == "1 cell \u{00B7} 2 recalculated \u{00B7} 1 row added",
          "a sheet counts the cells typed into apart from the formula cells")

    func thread(_ json: String) -> RanchReviewThread? { try? RanchOverview.decoder().decode(RanchReviewThread.self, from: Data(json.utf8)) }
    let applied = thread(#"{"id":"t1","path":"backoff.ts","state":"applied","anchor":{"kind":"line","line":9,"text":"x"},"by":{"id":"human:marcus","name":"Marcus Johnson","type":"HUMAN_COLLABORATOR"},"at":null,"resolved":null,"applied":{"at":null,"by":{"id":"human:desktop","name":"Desktop","type":"HUMAN_SELF"}},"position":{"line":9},"place":"Line 9","suggestion":{"before":"a","after":"b"},"pending":false,"comments":[]}"#)
    check(applied.map { RanchReviewWords.summary($0).lead + " \u{00B7} " + RanchReviewWords.summary($0).rest } == "Suggestion applied \u{00B7} Line 9 \u{00B7} Marcus Johnson",
          "an applied suggestion folds to who suggested it and where")
    let edited = thread(#"{"id":"t2","path":"notes.md","state":"applied","anchor":{"kind":"line","line":3,"text":"x"},"by":{"id":"human:desktop","name":"Desktop","type":"HUMAN_SELF"},"at":null,"resolved":null,"applied":{"at":null,"by":{"id":"agent:chatgpt","name":"ChatGPT","type":"AI_AGENT"}},"position":{"line":3},"place":"Line 3","suggestion":{"before":"a","after":"b"},"pending":false,"comments":[{"id":"c1","author":{"id":"agent:chatgpt","name":"ChatGPT","type":"AI_AGENT"},"initiatedBy":{"id":"human:dana","name":"Dana Walker","type":"HUMAN_SELF"},"body":"Capped it.","at":null,"pending":false,"executionId":"x1"}]}"#)
    check(edited.map { RanchReviewWords.summary($0).lead + " \u{00B7} " + RanchReviewWords.summary($0).rest } == "ChatGPT edited \u{00B7} Line 3 \u{00B7} asked by Dana Walker",
          "an AI's edit folds to the AI, the place and who asked")
    check(edited?.editedByAI == true && applied?.editedByAI == false, "a thread knows when the AI made its change")
}

// A Needs Review row names the old and new value and the claim they back.
do {
    func item(_ json: String) -> RanchReviewItem? { try? JSONDecoder().decode(RanchReviewItem.self, from: Data(json.utf8)) }
    let changed = item(#"{"id":"r1","kind":"changed","title":"Linked value changed","directoryId":"d","documents":["memo.md"],"detail":"x","before":"18,400","after":"19,250","claim":"Payroll came to 18,400"}"#)
    check(changed?.valueChangeLine == "18,400 \u{2192} 19,250 \u{00B7} \u{201C}Payroll came to 18,400\u{201D}",
          "a changed link reads as old to new value and its claim")
    let shown = item(#"{"id":"r3","kind":"changed","title":"Linked value changed","directoryId":"d","documents":["memo.md"],"detail":"x","before":"18400","after":"19250","beforeDisplay":"18,400","afterDisplay":"19,250"}"#)
    check(shown?.valueChangeLine == "18,400 \u{2192} 19,250", "a worksheet value's review line reads as the sheet formats it")
    let older = item(#"{"id":"r2","kind":"changed","title":"Linked value changed","directoryId":"d","documents":[],"detail":"x"}"#)
    check(older != nil && older?.valueChangeLine == nil, "an item from an older server reads as before")
}

// A preview names what the cited value was, and its history when it changed more than once.
do {
    func preview(_ history: String) -> AssistDocumentPreview? {
        AssistDocumentPreview.parse(Data(#"{"source":{"filename":"budget.csv","valueText":"19,250","objectType":"DATASET_VALUE","location":"B3"},"path":"budget.csv","preview":{"kind":"table","rows":[]},"history":\#(history)}"#.utf8), syntax: nil)
    }
    let once = preview(#"[{"value":"19,250"},{"value":"18,400"}]"#)
    check(once?.previousValue == "18,400" && once?.historyLine == nil, "a value changed once shows what it was, with no history line")
    check(once?.location == "B3", "the location is unchanged for a value changed once")
    let twice = preview(#"[{"value":"19,250"},{"value":"18,900"},{"value":"18,400"}]"#)
    check(twice?.historyLine == "18,400 \u{2192} 18,900 \u{2192} 19,250", "a value changed twice reads oldest to newest")
    check(twice?.location == "B3 \u{00B7} 18,400 \u{2192} 18,900 \u{2192} 19,250", "the history line sits beside the location")
    let never = preview(#"[{"value":"19,250"}]"#)
    check(never?.previousValue == nil && never?.historyLine == nil, "an unchanged value shows nothing more")
    let sentences = preview(#"[{"value":"The pump was replaced on Thursday after the seal failed."},{"value":"The pump was replaced on Wednesday after the seal failed."},{"value":"The pump was replaced on Tuesday after the seal failed."}]"#)
    check(sentences?.historyLine == nil && sentences?.location == "B3", "a passage edited twice gets no history line: its wordings would not fit")
    let older = AssistDocumentPreview.parse(Data(#"{"source":{"filename":"a.csv"},"preview":{}}"#.utf8), syntax: nil)
    check(older?.valueHistory == [], "a preview from an older server has no history")
}

// A cited passage marks the words that are new since its previous version.
do {
    let before = "Revenue rose to 18,400 in March."
    let after = "Revenue rose to 19,250 in April, as forecast."
    let changes = PassageWordDiff.changes(from: before, to: after)
    let words = changes.map { (after as NSString).substring(with: $0.range) }
    check(words == ["19,250", "April", "as", "forecast"], "only the words new since the previous version are marked")
    check(changes.first?.emphasized == true && changes.last?.emphasized == false, "a changed number is marked more strongly than a word")
    check(PassageWordDiff.changes(from: after, to: after).isEmpty, "an unchanged passage marks nothing")
    let long = Array(repeating: "word", count: PassageWordDiff.maxWords + 1).joined(separator: " ")
    check(PassageWordDiff.changes(from: long, to: long + " more").isEmpty, "a passage past the limit is not compared")
    let shown = "Totals were checked.\nRevenue rose to\n19,250 in April, as forecast. Costs held."
    let place = PassageWordDiff.onlyPlace(of: after, in: shown, within: NSRange(location: 0, length: (shown as NSString).length))
    check(place.map { (shown as NSString).substring(with: $0) } == "Revenue rose to\n19,250 in April, as forecast.",
          "a passage is found where it sits even when the preview breaks its lines")
    let twice = "\(after) \(after)"
    check(PassageWordDiff.onlyPlace(of: after, in: twice, within: NSRange(location: 0, length: (twice as NSString).length)) == nil,
          "a passage written twice in its block is not marked, since either could be the cited one")
}

// The Ranch's sheet view tints the cells its version changed, with what they were.
do {
    let json = #"{"sheets":[{"name":"Budget","columns":2,"rows":[["Line","Amount"],["Rent","4200"],["Payroll","19250"]],"rowNumbers":[1,2,3],"truncated":false}],"skipped":[],"version":"s2","versions":[{"snapshotId":"s2","at":"2026-11-10T15:04:00Z"},{"snapshotId":"s1","at":"2026-11-09T09:00:00Z"}],"changes":[{"sheet":"Budget","row":3,"column":1,"before":"18,400","after":"19,250","changedAt":"2026-11-10T15:04:00Z"}]}"#
    let book = try? JSONDecoder().decode(RanchWorkbook.self, from: Data(json.utf8))
    let cells = book?.changedCells(onSheet: 0) ?? [:]
    check(cells.count == 1 && cells[RanchCellKey(row: 2, column: 1)]?.before == "18,400", "a changed cell is found at the row the grid shows it on")
    check(cells[RanchCellKey(row: 2, column: 1)]?.hoverText(date: { _ in "Nov 10, 3:04 PM" }) == "was 18,400 \u{00B7} Nov 10, 3:04 PM",
          "hovering a changed cell says what it was and when")
    check(book?.versions?.map(\.snapshotId) == ["s2", "s1"], "the file's versions are listed newest first")
    let stored = try? JSONDecoder().decode(RanchCellChange.self, from: Data(#"{"sheet":"Budget","row":3,"column":1,"before":"18400","after":"19250","changedAt":null,"beforeDisplay":"18,400"}"#.utf8))
    check(stored?.hoverText(date: { _ in "" }) == "was 18,400", "a changed cell's hover names its earlier value as the sheet shows it")
    let older = try? JSONDecoder().decode(RanchWorkbook.self, from: Data(#"{"sheets":[],"skipped":[]}"#.utf8))
    check(older != nil && older?.changedCells(onSheet: 0).isEmpty == true && older?.versions == nil, "a workbook from an older server reads as before")
    let kept = try? JSONDecoder().decode(RanchFileVersion.self, from: Data(#"{"snapshotId":"s1","at":null,"available":false}"#.utf8))
    let notes = "# Log\r\n\nSoil moisture in **plot B** rose by 19 percent.\nIt rained."
    let passageJSON = #"{"version":"s2","changes":[{"kind":"text-excerpt","pageNumber":null,"start":8,"end":55,"lineStart":3,"lineEnd":3,"before":"Soil moisture in plot B rose by 18 percent.","after":"Soil moisture in plot B rose by 19 percent.","changedAt":"2026-11-10T15:04:00Z"}]}"#
    let passages = try? JSONDecoder().decode(RanchPassageChanges.self, from: Data(passageJSON.utf8))
    let passage = passages?.changes.first
    let found = passage?.range(in: notes).map { (notes as NSString).substring(with: $0) }
    check(found == "Soil moisture in **plot B** rose by 19 percent.", "a changed passage is found at its recorded place, Markdown markers and all (\(found ?? "nil"))")
    let moved = "Intro line.\n" + notes
    check(passage?.range(in: moved).map { (moved as NSString).substring(with: $0) } == nil,
          "a passage whose recorded place no longer holds it, and whose words are not written plainly, is not tinted")
    let plain = "Intro.\nSoil moisture in plot B rose by 19 percent.\n"
    check(passage?.range(in: plain).map { (plain as NSString).substring(with: $0) } == "Soil moisture in plot B rose by 19 percent.",
          "a passage is found by its words when its recorded place moved")
    check(passage?.note(date: { _ in "Nov 10, 3:04 PM" }) == "was \u{201C}Soil moisture in plot B rose by 18 percent.\u{201D} \u{00B7} Nov 10, 3:04 PM",
          "a changed passage's note quotes what it was and says when")
    check(kept?.available == false, "a version whose copy was not kept says so, and its menu entry is disabled")
}

print("the add control says how adding folders is going")
do {
    let thesis = "/Users/me/Documents/Thesis", notesPath = "/Users/me/Documents/Field Notes"
    var addition = FolderAddition(paths: [thesis])
    check(addition.state(folders: []) == .adding(title: "Adding Thesis", detail: "Waiting to start", percent: nil),
          "before the server reports, the island names the folder and shows no percentage")
    let reading = AddedFolderStatus(name: "Thesis", rootPath: thesis + "/",
                                    progress: DirectoryProgress(percent: 37, phase: "reading", kind: "adding"),
                                    fileCount: 0, needsAttention: false)
    check(addition.state(folders: [reading]) == .adding(title: "Adding Thesis", detail: "Reading files", percent: 37),
          "the chosen folder's progress is shown, its path matched despite a trailing slash")
    let thesisDone = AddedFolderStatus(name: "Thesis", rootPath: thesis, progress: nil, fileCount: 1240, needsAttention: false)
    let notesReading = AddedFolderStatus(name: "Field Notes", rootPath: notesPath,
                                         progress: DirectoryProgress(percent: 50, phase: "indexing", kind: "adding"),
                                         fileCount: 3, needsAttention: false)
    var both = FolderAddition(paths: [thesis, notesPath])
    check(both.state(folders: [thesisDone, notesReading]) == .adding(title: "Adding 2 folders", detail: "Indexing files", percent: 75),
          "several folders count together, a finished one as complete")
    check(both.state(folders: [notesReading]) == .adding(title: "Adding 2 folders", detail: "Indexing files", percent: 25),
          "a chosen folder the server has not listed yet counts as not started")
    addition.outcome = .succeeded
    check(addition.state(folders: [thesisDone]) == .done(title: "Thesis is ready", detail: "1,240 files"),
          "a finished folder says it is ready and how many files Lasso read")
    both.outcome = .succeeded
    let notesDone = AddedFolderStatus(name: "Field Notes", rootPath: notesPath, progress: nil, fileCount: 3, needsAttention: false)
    check(both.state(folders: [thesisDone, notesDone]) == .done(title: "2 folders are ready", detail: "1,243 files"),
          "several finished folders are counted together")
    check(FolderAddition.fileCountText(1) == "1 file", "one file is not written as plural")
    let troubled = AddedFolderStatus(name: "Thesis", rootPath: thesis, progress: nil, fileCount: 0, needsAttention: true)
    check(addition.state(folders: [troubled]) == .failed(title: "Thesis needs attention"),
          "a folder added but not usable says it needs attention rather than ready")
    addition.outcome = .failed
    check(addition.state(folders: []) == .failed(title: "Couldn\u{2019}t add Thesis"), "a failed request says the folder was not added")
    check(both.includes(rootPath: thesis + "/") && !both.includes(rootPath: "/Users/me/Documents/Other"),
          "a chosen folder's row is recognised, so only the island shows its progress")
}

print("the add control morphs on the Morph Island springs")
do {
    func firstArrival(_ spring: IslandSpring, to target: Double) -> (time: Double, peak: Double) {
        var spring = spring
        spring.t = target
        var time = 0.0, arrived: Double?, peak = spring.x
        while time < 2 {
            spring.step(1.0 / 480)
            time += 1.0 / 480
            peak = max(peak, spring.x)
            if arrived == nil, spring.x >= target { arrived = time }
        }
        return (arrived ?? .infinity, peak)
    }
    let height = firstArrival(IslandSpring(24, stiffness: 300, damping: 22), to: 52)
    check(height.peak > 52.5, "the height overshoots a little before it settles")
    var calm = IslandSpring(32, stiffness: 300, damping: 22)
    calm.tune(stiffness: 300, damping: 22, reduceMotion: true)
    check(firstArrival(calm, to: 52).peak <= 52.001, "with Reduce Motion the island lands without overshooting")
    check(abs(IslandCurve.ease(0.5) - 0.8024) < 0.002 && IslandCurve.land(1) == 1 && IslandCurve.land(0) == 0,
          "the contents fade along the same curves as the original's CSS")

    var now = 100.0
    let island = MorphIslandRow()
    island.drivesItself = false
    island.animatesOffscreen = true
    island.clock = { now }
    let add = NSMenuItem(title: "Add Work Directories\u{2026}", action: nil, keyEquivalent: "")
    add.isEnabled = true
    island.actionItem = add
    let restingHeight = island.frame.height
    check(island.accessibilityRole() == .button && island.accessibilityLabel() == add.title,
          "at rest the island is the Add Work Directories button")
    check(restingHeight == 26 && island.pillFrame.minX == 4 && island.pillFrame.maxX == island.bounds.width - 4,
          "at rest it is a panel row: as tall as the others, its highlight across the row")
    island.setFrameSize(NSSize(width: 300, height: island.frame.height))
    check(island.pillFrame.width == 292, "the row follows the panel's width")
    check(island.subviews.contains { $0.allowsVibrancy && !$0.isHidden },
          "at rest the row is drawn as the panel's rows are, with their vibrancy")
    island.show(.adding(title: "Adding Thesis", detail: "Reading files", percent: 40))
    let target = island.size(for: island.state)
    for _ in 0..<240 { now += 1.0 / 60; island.tick() }
    check(island.isAtRest(at: now) && abs(island.pillFrame.width - target.width) < 0.01
          && abs(island.pillFrame.height - target.height) < 0.01, "the island settles at the adding size")
    check(island.frame.height > restingHeight && island.frame.height >= target.height,
          "the panel row grows to hold the taller island")
    check(island.subviews.allSatisfy(\.isHidden), "while adding, only the card shows")
    check(island.shownPercent == 40 && island.accessibilityRole() == .progressIndicator
          && (island.accessibilityValue() as? NSNumber)?.intValue == 40,
          "the count reaches the server's percentage and VoiceOver hears it")
    island.show(.adding(title: "Adding Thesis", detail: "Reading files", percent: 30))
    check(island.shownPercent == 40, "the count never goes back within one addition")
    var handedBack = false
    island.onHoldEnded = { handedBack = true }
    island.show(.done(title: "Thesis is ready", detail: "1,240 files"))
    island.hold(for: 2.7)
    check(!handedBack, "a finished addition stays on screen for a moment")
    island.hold(for: 0.2)
    check(handedBack, "after the token's 2.8 seconds on screen it hands back to the button")
    island.show(.idle)
    for _ in 0..<240 { now += 1.0 / 60; island.tick() }
    check(abs(island.frame.height - restingHeight) < 1, "back at rest, the row is its resting height again")

    let unseen = MorphIslandRow()
    unseen.drivesItself = false
    unseen.show(.adding(title: "Adding Thesis", detail: "Waiting to start", percent: nil))
    check(unseen.pillFrame.size == unseen.size(for: unseen.state),
          "an island nobody can see jumps to its new size instead of animating")

    func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
    let controller = StatusPopoverController()
    func panel() -> NSMenu {
        let menu = NSMenu()
        let more = NSMenuItem(title: "More", action: nil, keyEquivalent: "")
        more.submenu = NSMenu()
        more.submenu?.addItem(NSMenuItem(title: "External Drives", action: nil, keyEquivalent: ""))
        menu.addItem(more)
        let fresh = NSMenuItem(title: "Add Work Directories\u{2026}", action: nil, keyEquivalent: "")
        fresh.view = island
        island.actionItem = fresh
        menu.addItem(fresh)
        return menu
    }
    controller.update(menu: panel())
    let root = controller.popover.contentViewController!.view
    controller.update(menu: panel())
    check(descendants(root).filter { $0 is MorphIslandRow }.count == 1 && island.superview != nil,
          "rebuilding the panel keeps the one island, so its motion carries on")
    let moreButton = descendants(root).compactMap { $0 as? NSButton }.first { $0.title == "More" }
    moreButton?.performClick(nil)
    check(moreButton != nil && descendants(root).contains { $0 === island },
          "opening a group in the panel keeps the island")
}

// The passage picker: what a highlight inserts, how it is cited, and how it joins the typed words.
do {
    let json = #"""
    {"document":{"name":"Site Standup.mov","kind":"video","lineBreaks":"space","truncated":false,
     "text":"0:00  Good morning.\n0:02  The fire inspection is booked.\n",
     "decorations":[{"start":0,"end":6},{"start":20,"end":26}],"headings":[],
     "places":[{"start":6,"end":10,"kind":"time","time":0.0},{"start":11,"end":19,"kind":"time","time":0.5},
               {"start":26,"end":29,"kind":"time","time":2.7},{"start":30,"end":34,"kind":"time","time":3.0},
               {"start":35,"end":45,"kind":"time","time":3.3}],
     "selection":{"start":26,"end":56}}}
    """#
    let video = PassageDocument.parse(Data(json.utf8))
    check(video?.selection == NSRange(location: 26, length: 30), "the picker opens on the passage the suggestion cited")
    let both = NSRange(location: 0, length: 56)
    check(video?.insertedText(both) == "Good morning. The fire inspection is booked.",
          "a highlight across a video's lines is inserted as one run of words, without the times (\(video?.insertedText(both) ?? "nil"))")
    check(video?.citation(for: NSRange(location: 26, length: 30)) == "(Site Standup.mov, 0:02)", "a video is cited at the moment the highlight starts")
    check(video?.time(of: NSRange(location: 30, length: 4)) == 3.0, "a video link starts where the highlight does")

    let slides = PassageDocument(name: "Q3-Sprint-Review.pptx", kind: "slides", text: "Slide 2\nHighlights\n• Panel live\n\nSlide 3\n• Rate limit raised\n",
        decorations: [NSRange(location: 0, length: 8), NSRange(location: 19, length: 2), NSRange(location: 33, length: 8), NSRange(location: 41, length: 2)],
        headings: [], places: [PassagePlace(range: NSRange(location: 8, length: 24), kind: "slide", time: nil, number: 2, title: nil),
                               PassagePlace(range: NSRange(location: 41, length: 19), kind: "slide", time: nil, number: 3, title: nil)],
        joinsLines: false, selection: nil, unavailable: nil, truncated: false)
    check(slides.insertedText(NSRange(location: 8, length: 24)) == "Highlights\nPanel live", "a deck's lines stay lines, without their bullets")
    check(slides.citation(for: NSRange(location: 21, length: 10)) == "(Q3-Sprint-Review.pptx, slide 2)", "a slide is cited by the file and its number")
    check(slides.citation(for: NSRange(location: 21, length: 30)) == "(Q3-Sprint-Review.pptx, slides 2\u{2013}3)", "a highlight across slides cites them all")
    check(PassageDocument.numbered("page", [3, 5]) == "pages 3, 5", "pages apart are listed")

    // Words read off a slide's picture, matched to the deck's own text so the inserted words are exact.
    let read = [PassageSlideWord(text: "HIGHLIGHTS", box: CGRect(x: 0.1, y: 0.1, width: 0.4, height: 0.08), line: 0),
                PassageSlideWord(text: "Pane1", box: CGRect(x: 0.12, y: 0.3, width: 0.12, height: 0.05), line: 1),
                PassageSlideWord(text: "live", box: CGRect(x: 0.26, y: 0.3, width: 0.08, height: 0.05), line: 1)]
    let onSlide = PassageSlideWords.aligned(read, to: slides, slide: 2)
    check(onSlide.map(\.source) == [NSRange(location: 8, length: 10), NSRange(location: 21, length: 5), NSRange(location: 27, length: 4)],
          "each word on a slide's picture is matched to the deck's text, a misread word between two matches included")
    check(PassageSlideWords.text(onSlide, 0...2, in: slides) == "Highlights\nPanel live",
          "words highlighted on a slide insert as the deck writes them, not as they were read off the picture")
    check(PassageSlideWords.citation(onSlide, 1...2, in: slides) == "(Q3-Sprint-Review.pptx, slide 2)", "words on a slide cite that slide")
    check(PassageSlideWords.covering(onSlide, NSRange(location: 21, length: 10)) == 1...2,
          "the passage the suggestion cited opens highlighted on the slide")
    check(PassageSlideWords.nearest(onSlide, to: CGPoint(x: 0.3, y: 0.33)) == 2
          && PassageSlideWords.nearest(onSlide, to: CGPoint(x: 0.9, y: 0.32)) == 2
          && PassageSlideWords.nearest(onSlide, to: CGPoint(x: 0.05, y: 0.12)) == 0,
          "a press on or beside a line of the slide lands on its nearest word")
    let unmatched = [PassageSlideWord(text: "Logo", box: CGRect(x: 0.8, y: 0.9, width: 0.1, height: 0.05), line: 2)]
    check(PassageSlideWords.text(PassageSlideWords.aligned(unmatched, to: slides, slide: 2), 0...0, in: slides) == "Logo",
          "words the deck's text does not have are inserted as they were read")
    check(PassageDocument.numbered("line", [12, 14], listed: false) == "lines 12\u{2013}14", "lines are cited as a span")
    let memo = PassageDocument(name: "Spec.docx", kind: "word", text: "Scope", decorations: [], headings: [],
        places: [PassagePlace(range: NSRange(location: 0, length: 5), kind: "section", time: nil, number: nil, title: nil)],
        joinsLines: false, selection: nil, unavailable: nil, truncated: false)
    check(memo.citation(for: NSRange(location: 0, length: 5)) == "(Spec.docx)", "a Word paragraph with no heading above it cites the file alone")
    check(PassageDocument.timestamp(3723) == "1:02:03" && PassageDocument.timestamp(4.6) == "0:04", "times read as a player shows them")

    let quoted = PassageInsertion.plan(body: "The fire inspection is booked for the 15th.", citation: "(Site Standup.mov, 0:02)",
                                       quoted: true, before: "Reminder that the fire insp")
    check(quoted == .init(text: "\"The fire inspection is booked for the 15th.\" (Site Standup.mov, 0:02)", replaceStart: 14, replaceEnd: 27),
          "a quote that starts with the typed words is typed in their place, never after them")
    let opened = PassageInsertion.plan(body: "The fire inspection is booked.", citation: "(Site Standup.mov, 0:02)", quoted: true, before: "He said \"the fire")
    check(opened?.replaceStart == 8 && opened?.text.hasPrefix("\"The fire") == true, "a quote the writer opened is not opened twice")
    let after = PassageInsertion.plan(body: "Tracking panel live", citation: "(Review.pptx, slide 2)", quoted: false, before: "Customers saw it go")
    check(after == .init(text: " Tracking panel live (Review.pptx, slide 2)", replaceStart: 19, replaceEnd: 19),
          "a highlight that does not start with the typed words goes after them, set apart by a space")
    let otherForm = PassageInsertion.plan(body: "Shipments stored in PostgreSQL behind a fixed connection pool", citation: nil,
                                          quoted: false, before: "The shipment stored")
    check(otherForm == .init(text: "Shipments stored in PostgreSQL behind a fixed connection pool", replaceStart: 4, replaceEnd: 19),
          "typed words in another form of the highlight's first words (shipment, Shipments) are replaced, never written twice")
    check(PassageInsertion.plan(body: "News of the merger", citation: nil, quoted: false, before: "It was new ")?.replaceStart == 11,
          "short words in other forms are not taken for each other")
    let plain = PassageInsertion.plan(body: "raised from 100 to 120", citation: nil, quoted: true, before: "It was raised ")
    check(plain == .init(text: "raised from 100 to 120", replaceStart: 7, replaceEnd: 13),
          "without its source a highlight is inserted exactly, unquoted, keeping the space typed after the words")
    check(PassageInsertion.plan(body: "  ", citation: nil, quoted: false, before: "x") == nil, "nothing highlighted inserts nothing")
    let fire = PassageTrigger(fromEnd: 8, length: 8, text: "the fire")
    let chosen = PassageInsertion.plan(body: "Please keep the loading dock clear after four.", citation: nil, quoted: true,
                                       before: "Note: the fire", replacing: fire)
    check(chosen == .init(text: "Please keep the loading dock clear after four.", replaceStart: 6, replaceEnd: 14),
          "a highlight the writer chose takes the place of the typed words the suggestion was found by")
    let cited = PassageInsertion.plan(body: "Please keep the loading dock clear after four.", citation: "(Site Standup.mov, 0:07)",
                                      quoted: true, before: "Note: the fire ", replacing: PassageTrigger(fromEnd: 9, length: 8, text: "the fire"))
    check(cited?.replaceStart == 6 && cited?.replaceEnd == 14 && cited?.text.hasPrefix("\"Please keep") == true,
          "a chosen quote replaces the typed words and keeps the space typed after them")
    check(PassageTrigger(fromEnd: 8, length: 8, text: "the fire").range(in: "Note: the fir") == nil,
          "typed words that changed since are not replaced")

    let picking = KeyRoutingState(passagePickerOpen: true, popup: .suggestions)
    let pickerKey = { (code: Int64, flags: CGEventFlags) in KeyRouter.decide(keyCode: code, flags: flags, synthetic: false, state: picking) }
    check(pickerKey(48, []) == .swallow(.pickerInsert), "Tab in the picker inserts the highlight")
    check(pickerKey(53, []) == .swallow(.pickerCancel), "Escape in the picker goes back to the card")
    check(pickerKey(36, [.maskCommand, .maskShift]) == .swallow(.pickerLink), "\u{21E7}\u{2318}Return in the picker inserts a link")
    check(pickerKey(124, [.maskShift]) == .swallow(.pickerMove(forward: true, byLine: false, extending: true)), "\u{21E7}\u{2192} extends the highlight a word")
    check(pickerKey(125, []) == .swallow(.pickerMove(forward: true, byLine: true, extending: false)), "\u{2193} moves the highlight a line")
    check(pickerKey(0, []) == .pass(.pickerTypedOn), "a letter goes on to the app and closes the picker")
    check(pickerKey(8, [.maskCommand]) == .pass(nil), "a shortcut stays the app's and leaves the picker open")
    check(pickerKey(48, [.maskShift]) == .pass(.pickerTypedOn), "\u{21E7}Tab is the app's, and closes the picker")

    let segment: [String: Any] = ["id": "o1", "path": "clips/Site Standup.mov", "anchor": ["start": 0],
                                  "metadata": ["componentType": "VIDEO_SEGMENT"]]
    check(PassageDocument.opensPicker(candidate: segment), "a video's spoken passage opens the picker")
    var wholeVideo = segment; wholeVideo["anchor"] = nil; wholeVideo["metadata"] = ["componentType": "VIDEO"]
    check(!PassageDocument.opensPicker(candidate: wholeVideo), "a whole file named by its name inserts its name")
    let cell: [String: Any] = ["id": "o2", "path": "Budget.xlsx", "anchor": ["row": 3], "metadata": ["componentType": "CELL"]]
    check(!PassageDocument.opensPicker(candidate: cell), "a value from a table inserts as before")
}

// MARK: The sheet picker

do {
    let json = """
    {"document": {"name": "Pumps.xlsx", "sheet": "Trial Balance", "sheets": ["Trial Balance", "Notes"],
      "columns": ["A", "B", "C"], "headerRow": 1, "truncated": false,
      "selection": {"top": 3, "bottom": 3, "left": 1, "right": 1},
      "rows": [{"number": 1, "cells": ["Pump", "Flow gpm", "Head ft"]},
               {"number": 2, "cells": ["P-101", "18,400", "120"]},
               {"number": 3, "cells": ["P-204", "9,750", "95"]},
               {"number": 5, "cells": ["P-305", "12,200", "110"]}]}}
    """
    guard let sheet = SheetDocument.parse(Data(json.utf8)) else { fatalError("the sheet parses") }
    check(sheet.name == "Pumps.xlsx" && sheet.sheets.count == 2 && sheet.headerRow == 1, "a sheet reads its name, sheets and header row")
    check(sheet.selection == SheetRange(top: 3, bottom: 3, left: 1, right: 1), "a sheet opens on the cited cell")
    check(sheet.cell(row: 2, column: 1) == "18,400" && sheet.cell(row: 4, column: 0) == "", "cells are read by sheet row number")
    check(SheetDocument.parse(Data("{\"document\": {\"name\": \"x.csv\", \"unavailable\": \"Gone.\"}}".utf8))?.unavailable == "Gone.",
          "a sheet that cannot be shown says why")

    check(SheetRange(top: 5, bottom: 2, left: 2, right: 0) == SheetRange(top: 2, bottom: 5, left: 0, right: 2),
          "a range dragged up or left is the same range")
    check(SheetRange(top: 3, bottom: 3, left: 1, right: 1).a1 == "B3" && SheetRange(top: 2, bottom: 5, left: 0, right: 2).a1 == "A2:C5",
          "a range is named as Excel names it")

    let flow = SheetRange(top: 2, bottom: 2, left: 1, right: 1)
    let head = SheetRange(top: 3, bottom: 3, left: 2, right: 2)
    let two = SheetHighlights().adding(flow).adding(head)
    check(two.ranges == [flow, head], "highlights are kept in the order they were made, and need not touch")
    check(two.undoing().ranges == [flow], "\u{2318}Z removes the latest highlight")
    check(two.undoing().redoing().ranges == [flow, head], "\u{21E7}\u{2318}Z brings it back")
    check(two.undoing().adding(flow).redoing().ranges == [flow, flow], "a new highlight ends what \u{21E7}\u{2318}Z could bring back")
    check(SheetHighlights().undoing().ranges.isEmpty, "\u{2318}Z with nothing highlighted does nothing")
    let moved = SheetHighlights().adding(SheetRange(top: 3, bottom: 3, left: 1, right: 1)).moving(columns: 0, rows: 1, extending: false, in: sheet)
    check(moved.ranges == [SheetRange(top: 5, bottom: 5, left: 1, right: 1)], "\u{2193} moves the latest highlight to the next row the sheet has")
    let extended = SheetHighlights().adding(flow).moving(columns: 1, rows: 0, extending: true, in: sheet)
    check(extended.ranges == [SheetRange(top: 2, bottom: 2, left: 1, right: 2)], "\u{21E7}\u{2192} widens the latest highlight a column")
    check(SheetHighlights().adding(SheetRange(top: 2, bottom: 2, left: 2, right: 2)).moving(columns: 1, rows: 0, extending: false, in: sheet).ranges
          == [SheetRange(top: 2, bottom: 2, left: 2, right: 2)], "a highlight stops at the sheet's last column")

    let twoApart = [flow, SheetRange(top: 5, bottom: 5, left: 2, right: 2)]
    let laid = SheetClipboard.grid(sheet, twoApart, headers: false)
    check(laid.cells == [["18,400", ""], ["", "110"]] && !laid.headed,
          "the picture keeps the cells where they sit and closes the rows and columns between highlights")
    let withHeaders = SheetClipboard.grid(sheet, [flow, head], headers: true)
    check(withHeaders.cells == [["Flow gpm", "Head ft"], ["18,400", ""], ["", "95"]] && withHeaders.headed,
          "with headers, the touched columns' header row comes first")
    let takesHeader = SheetClipboard.grid(sheet, [SheetRange(top: 1, bottom: 2, left: 0, right: 0)], headers: true)
    check(takesHeader.cells == [["Pump"], ["P-101"]] && takesHeader.headed,
          "a highlight that takes in the header row does not repeat it, and heads the picture with it")
    let partialHeader = [SheetRange(top: 2, bottom: 3, left: 0, right: 0), SheetRange(top: 1, bottom: 3, left: 2, right: 2)]
    let onlyHighlightedHeader = SheetClipboard.grid(sheet, partialHeader, headers: false)
    check(onlyHighlightedHeader.cells == [["", "Head ft"], ["P-101", "120"], ["P-204", "95"]] && onlyHighlightedHeader.headed,
          "highlighting a header cell includes that header without adding unhighlighted columns' headers")
    let allColumnHeaders = SheetClipboard.grid(sheet, partialHeader, headers: true)
    check(allColumnHeaders.cells == [["Pump", "Head ft"], ["P-101", "120"], ["P-204", "95"]] && allColumnHeaders.headed,
          "with headers on, all highlighted columns get their headers even when one header was already highlighted")
    let titled = SheetDocument(name: "Report.xlsx", sheet: "Summary", sheets: ["Summary"], columns: ["A", "B"],
                               rows: [SheetRow(number: 1, cells: ["Q3 Summary", ""]),
                                      SheetRow(number: 2, cells: ["Invoice", "Due Date"]),
                                      SheetRow(number: 3, cells: ["BILL-1160", "2026-09-17"])],
                               headerRow: 2, selection: nil, truncated: false)
    let titledPartial = [SheetRange(top: 1, bottom: 1, left: 0, right: 0),
                         SheetRange(top: 3, bottom: 3, left: 0, right: 0),
                         SheetRange(top: 2, bottom: 3, left: 1, right: 1)]
    check(SheetClipboard.grid(titled, titledPartial, headers: false).cells
          == [["Q3 Summary", ""], ["", "Due Date"], ["BILL-1160", "2026-09-17"]],
          "a title above a highlighted header keeps only the highlighted header when headers is off")
    check(SheetClipboard.grid(titled, titledPartial, headers: true).cells
          == [["Q3 Summary", ""], ["Invoice", "Due Date"], ["BILL-1160", "2026-09-17"]],
          "with headers on, a header row below a highlighted title still fills every highlighted column's header")
    check(SheetClipboard.citation(sheet, twoApart) == "(Pumps.xlsx, 'Trial Balance'!B2, C5)", "the source cites each highlight in order")
    let csv = SheetDocument(name: "pumps.csv", sheet: nil, sheets: [], columns: ["A", "B"],
                            rows: [SheetRow(number: 1, cells: ["Pump", "Note"])], headerRow: 1, selection: nil, truncated: false)
    check(SheetClipboard.citation(csv, [SheetRange(top: 1, bottom: 1, left: 1, right: 1)]) == "(pumps.csv, B1)", "a CSV is cited without a sheet")
    check(SheetClipboard.pick(sheet, highlights: [], headers: false, citing: true) == nil, "nothing highlighted inserts nothing")
    let withBlank = SheetDocument(name: "ap.csv", sheet: nil, sheets: [], columns: ["A", "B", "C"],
                                  rows: [SheetRow(number: 1, cells: ["Invoice", "", "Due"]), SheetRow(number: 2, cells: ["BILL-1160", "", "2026-09-17"]),
                                         SheetRow(number: 3, cells: [""])], headerRow: 1, selection: nil, truncated: false)
    check(SheetClipboard.grid(withBlank, [SheetRange(top: 1, bottom: 3, left: 0, right: 2)], headers: false).cells
          == [["Invoice", "Due"], ["BILL-1160", "2026-09-17"]], "rows and columns with nothing in them are left out of the picture")
    let blankOnly = SheetClipboard.grid(withBlank, [SheetRange(top: 3, bottom: 3, left: 0, right: 0)], headers: true)
    check(blankOnly.cells.isEmpty && !blankOnly.headed && !SheetClipboard.hasCells(withBlank, [SheetRange(top: 3, bottom: 3, left: 0, right: 0)], headers: true),
          "highlighting only empty cells inserts nothing even with headers on")
    check(SheetClipboard.hasCells(sheet, [flow], headers: false), "a non-empty highlight can be inserted")

    let typedInv = CompletionReplacement.capture(start: 0, end: 3, in: "inv")
    check(SheetClipboard.typedTrigger(nil, before: "inv") == typedInv,
          "the unfinished word that brought up the suggestion is replaced by the picture")
    check(SheetClipboard.typedTrigger(nil, before: "Due dates: inv") == CompletionReplacement.capture(start: 11, end: 14, in: "Due dates: inv"),
          "only that word, not the words before it")
    check(SheetClipboard.typedTrigger(nil, before: "The invoices are ") == nil, "after a finished word nothing typed is removed")
    let named = CompletionReplacement.capture(start: 4, end: 14, in: "The accrued pa")
    check(SheetClipboard.typedTrigger(named, before: "The accrued pa") == named, "a matched name is replaced whole")
    let nbspBefore = "The accrued\u{00A0}pa"
    check(SheetClipboard.typedTrigger(named, before: nbspBefore) == CompletionReplacement.capture(start: 4, end: 14, in: nbspBefore),
          "a matched name still replaces when a web editor turns spaces into non-breaking spaces")
    check(SheetClipboard.typedTrigger(typedInv, before: "invo") == CompletionReplacement.capture(start: 0, end: 4, in: "invo"),
          "a stale replacement falls back to the unfinished word now at the caret")
    check(SheetClipboard.typedTrigger(CompletionReplacement(start: 3, expectedText: ""), before: "inv") == typedInv,
          "a suggestion that only adds at the caret still takes away the unfinished word")
    check(RichTextInserter.deletesBeforePaste(selected: true, deletesFirst: true, replacing: 3, keyboardDeleteCount: 3) == 1,
          "a selected typed word is deleted before a picture is pasted, as attachments leave the selection")
    check(RichTextInserter.deletesBeforePaste(selected: false, deletesFirst: true, replacing: 3, keyboardDeleteCount: 3) == 3,
          "without a selection the typed letters are deleted one by one")
    check(RichTextInserter.deletesBeforePaste(selected: true, deletesFirst: false, replacing: 3, keyboardDeleteCount: 3) == 0
          && RichTextInserter.deletesBeforePaste(selected: true, deletesFirst: true, replacing: 0, keyboardDeleteCount: 0) == 0,
          "a link pastes over its selected word, and with nothing typed nothing is deleted")
    check(!RichTextInserter.shouldSelectBeforePaste(replacing: 3, at: 3, deletesFirst: true, keyboardDeleteCount: 3, hasMarkedText: false),
          "short picture pastes without marked text delete by keyboard instead of mutating AX selection")
    check(RichTextInserter.shouldSelectBeforePaste(replacing: 3, at: 3, deletesFirst: true, keyboardDeleteCount: 3, hasMarkedText: true),
          "picture pastes with pending marked text still clear it via selection")
    check(RichTextInserter.shouldSelectBeforePaste(replacing: 3, at: 3, deletesFirst: false, keyboardDeleteCount: 3, hasMarkedText: false),
          "share links still select the replaced word before pasting over it")
    check(!RichTextInserter.shouldSelectBeforePaste(replacing: 3, at: 3, deletesFirst: false, keyboardDeleteCount: 3, hasMarkedText: true, avoidSelection: true)
          && RichTextInserter.shouldSelectBeforePaste(replacing: 40, at: 40, deletesFirst: false, keyboardDeleteCount: 40, hasMarkedText: false, avoidSelection: true),
          "hosts that avoid AX selection delete short prefixes by keyboard before pasting, even with marked text")
    check(!RichTextInserter.shouldSelectBeforePaste(replacing: 3, at: -1, deletesFirst: false, keyboardDeleteCount: 3, hasMarkedText: false),
          "editors addressed by markers never attempt an integer selection write")
    check(RichTextInserter.bareCaretForPaste(replacing: 3, at: -1, deletesFirst: true) == nil,
          "marker-addressed editors never compute a negative bare caret")
    check(RichTextInserter.bareCaretForPaste(replacing: 3, at: 3, deletesFirst: true) == 0
          && RichTextInserter.bareCaretForPaste(replacing: 0, at: 5, deletesFirst: false) == 5
          && RichTextInserter.bareCaretForPaste(replacing: 3, at: 5, deletesFirst: false) == nil,
          "bare caret is computed only for an integer caret after a deletion or at an empty range")

    let plainLayout = SheetPicture.layout(laid.cells, headed: false, caption: nil)
    let headedLayout = SheetPicture.layout(withHeaders.cells, headed: true, caption: nil)
    let captioned = SheetPicture.layout(laid.cells, headed: false, caption: "(Pumps.xlsx, 'Trial Balance'!B2, C5)")
    check(plainLayout.columnWidths.count == 2 && headedLayout.size.height > plainLayout.size.height,
          "the picture has a column per touched column and a row per touched row")
    check(captioned.size.height > plainLayout.size.height && captioned.size.width >= plainLayout.size.width,
          "the source is written under the picture")
    let picture = SheetClipboard.pick(sheet, highlights: [flow, head], headers: true, citing: true)
    let png = picture.flatMap { NSBitmapImageRep(data: $0.png) }
    check(png != nil && picture?.tiff != nil, "the picture is put on the clipboard as PNG and TIFF")
    let orderedFormats = picture.map(SheetClipboard.pasteboardFormats(for:)) ?? []
    check(orderedFormats.map(\.0) == [.png, .tiff], "PNG is placed on the clipboard before TIFF")
    let imageBoard = NSPasteboard.withUniqueName()
    defer { imageBoard.releaseGlobally() }
    if let picture {
        check(RichTextInserter.writeFormats(SheetClipboard.pasteboardFormats(for: picture), to: imageBoard),
              "the picture writes to a pasteboard item")
        let writtenTypes = imageBoard.pasteboardItems?.first?.types ?? []
        check(writtenTypes.first == .png && writtenTypes.contains(.tiff),
              "the pasteboard item declares PNG first and keeps TIFF as a fallback")
    }
    let expected = SheetPicture.layout(withHeaders.cells, headed: true, caption: picture?.citation)
    check(png?.pixelsWide == Int(expected.size.width * SheetPicture.scale) && png?.pixelsHigh == Int(expected.size.height * SheetPicture.scale),
          "the picture is drawn at Retina resolution")
    let headerPixel = png?.colorAt(x: 3, y: 3)?.usingColorSpace(.sRGB)
    let bodyPixel = png?.colorAt(x: 3, y: Int((SheetPicture.rowHeight + 6) * SheetPicture.scale))?.usingColorSpace(.sRGB)
    check(headerPixel != nil && bodyPixel != nil && headerPixel!.brightnessComponent < bodyPixel!.brightnessComponent,
          "the header row is shaded, the cells below are white")
    check(SheetCells.isNumber("$18,400") && SheetCells.isNumber("(1,200)") && !SheetCells.isNumber("2026-09-17") && !SheetCells.isNumber("P-101")
          && SheetCells.isNumber("-"), "numbers, and an accounting zero's dash, are told from dates and names, to set them right")

    let card = KeyRoutingState(popup: .suggestions, sheetPickable: true)
    let cardKey = { (code: Int64, flags: CGEventFlags) in KeyRouter.decide(keyCode: code, flags: flags, synthetic: false, state: card) }
    check(cardKey(48, [.maskSecondaryFn]) == .swallow(.openSheetPicker), "fn+Tab on a sheet's suggestion opens the sheet picker")
    check(cardKey(48, []) == .swallow(.activate), "Tab on a sheet's suggestion inserts it as before")
    check(KeyRouter.decide(keyCode: 48, flags: [.maskSecondaryFn], synthetic: false, state: KeyRoutingState(popup: .suggestions))
          == .swallow(.activate), "fn+Tab on any other suggestion is Tab")
    let sheetPicking = KeyRoutingState(popup: .suggestions, sheetPickerOpen: true)
    let sheetKey = { (code: Int64, flags: CGEventFlags) in KeyRouter.decide(keyCode: code, flags: flags, synthetic: false, state: sheetPicking) }
    check(sheetKey(48, []) == .swallow(.sheetInsert) && sheetKey(48, [.maskSecondaryFn]) == .swallow(.sheetInsert), "Tab in the sheet picker inserts the highlights")
    check(sheetKey(53, []) == .swallow(.sheetCancel), "Escape in the sheet picker goes back to the card")
    check(sheetKey(6, [.maskCommand]) == .swallow(.sheetUndo), "\u{2318}Z in the sheet picker removes the latest highlight")
    check(sheetKey(6, [.maskCommand, .maskShift]) == .swallow(.sheetRedo), "\u{21E7}\u{2318}Z brings it back")
    check(sheetKey(125, [.maskShift]) == .swallow(.sheetMove(columns: 0, rows: 1, extending: true)), "\u{21E7}\u{2193} extends the latest highlight")
    check(sheetKey(0, []) == .pass(.pickerTypedOn), "a letter goes on to the app and closes the sheet picker")
    check(sheetKey(8, [.maskCommand]) == .pass(nil), "a shortcut stays the app's")
    let sheetAndScope = KeyRoutingState(popup: .suggestions, sheetPickerOpen: true, scopeSwitchAvailable: true)
    check(KeyRouter.decide(keyCode: 48, flags: [.maskAlternate], synthetic: false, state: sheetAndScope) != .swallow(.openScopeSwitcher),
          "\u{2325}Tab does not open the folder switcher over the sheet picker")
}

print("⌥Tab chooses the folder suggestions come from")
do {
    let tab: Int64 = 48, returnKey: Int64 = 36, escape: Int64 = 53, up: Int64 = 126, down: Int64 = 125
    func key(_ code: Int64, _ flags: CGEventFlags, _ state: KeyRoutingState) -> KeyDecision {
        KeyRouter.decide(keyCode: code, flags: flags, synthetic: false, state: state)
    }
    let ready = KeyRoutingState(scopeSwitchAvailable: true)
    check(key(tab, .maskAlternate, ready) == .swallow(.openScopeSwitcher), "⌥Tab opens the switcher")
    check(key(tab, .maskAlternate, KeyRoutingState(popup: .suggestions, scopeSwitchAvailable: true)) == .swallow(.openScopeSwitcher),
          "⌥Tab opens the switcher over a card, rather than closing the card")
    check(key(tab, [.maskAlternate, .maskShift], ready) == .swallow(.openScopeSwitcher), "⇧⌥Tab opens it too")
    check(key(tab, .maskAlternate, KeyRoutingState()) != .swallow(.openScopeSwitcher),
          "with suggestions off, no folder on, or an app Lasso stays quiet in, ⌥Tab is the app's")
    check(key(tab, [.maskAlternate, .maskCommand], ready) != .swallow(.openScopeSwitcher), "⌥⌘Tab is not the switcher's")
    check(key(tab, [], ready) == .pass(.followTyping(trackCaret: false)), "a bare Tab with nothing open is still the app's")
    check(key(tab, .maskAlternate, KeyRoutingState(passagePickerOpen: true, scopeSwitchAvailable: true)) != .swallow(.openScopeSwitcher),
          "the passage picker keeps its keys")
    check(key(tab, .maskAlternate, KeyRoutingState(shareComposerOpen: true, scopeSwitchAvailable: true)) != .swallow(.openScopeSwitcher),
          "the share options keep their keys")

    let open = KeyRoutingState(popup: .hidden, scopeSwitcherOpen: true, scopeSwitchAvailable: true)
    check(key(tab, .maskAlternate, open) == .swallow(.scopeMove(1)), "⌥Tab again rolls to the next folder")
    check(key(tab, [], open) == .swallow(.scopeMove(1)), "Tab rolls to the next folder")
    check(key(tab, .maskShift, open) == .swallow(.scopeMove(-1)), "⇧Tab rolls back")
    check(key(down, [], open) == .swallow(.scopeRow(1)) && key(up, [], open) == .swallow(.scopeRow(-1)),
          "↓ shows the row that chooses the AI writer, and ↑ the folders again")
    check(key(returnKey, [], open) == .swallow(.scopeChoose) && key(76, [], open) == .swallow(.scopeChoose),
          "Return keeps the folder shown")
    check(key(escape, [], open) == .swallow(.scopeCancel), "Escape leaves the choice as it was")
    check(key(0, [], open) == .pass(.scopeTypedOn), "a letter goes on to the app and closes the switcher")
    check(key(8, .maskCommand, open) == .pass(.scopeCancel), "a shortcut stays the app's and closes the switcher")
    check(key(tab, .maskAlternate, KeyRoutingState(isInserting: true, scopeSwitcherOpen: true)) == .pass(nil),
          "keys pass untouched while Lasso types an insertion")

    let finance = SourceScopeEntry(projectId: "p1", title: "Finance", symbol: "folder.fill")
    let plans = SourceScopeEntry(projectId: "p2", title: "Plans", symbol: "folder.fill")
    let mail = SourceScopeEntry(projectId: "p3", title: "Outlook", symbol: "envelope")
    var scope = SourceScope()
    check(scope.chosen == .all && scope.entries == [.all], "with no folders the switcher offers All alone")
    scope.update([finance, plans, mail, finance])
    check(scope.entries == [.all, finance, plans, mail], "All comes first, then each switched-on folder and app once")
    check(scope.index(from: 0, by: 1) == 1 && scope.index(from: 3, by: 1) == 0 && scope.index(from: 0, by: -1) == 3,
          "rolling past the last goes back round to All, both ways")
    check(scope.choose(at: 2) && scope.chosenProjectId == "p2" && scope.chosen == plans, "Return on a folder chooses it")
    check(!scope.choose(at: 2), "choosing the folder already chosen changes nothing")
    check(!scope.update([finance, plans]) && scope.chosen == plans, "other folders switching off keep the choice")
    check(scope.update([finance, mail]) && scope.chosen == .all, "the chosen folder switched off goes back to All")
    check(scope.choose(at: 1) && scope.choose(at: 0) && scope.chosenProjectId == nil, "All is chosen like any other")

    let visible = CGRect(x: 0, y: 0, width: 1440, height: 900)
    let size = CGSize(width: 300, height: 44)
    let below = ScopeSwitcherPlacement.frame(caret: CGRect(x: 400, y: 500, width: 2, height: 18), size: size, visible: visible)
    check(below.maxY == 500 - ScopeSwitcherPlacement.gap && below.minX == 400 - ScopeSwitcherPlacement.leadIn,
          "the pill sits just below the caret line, starting a little before the caret")
    let low = ScopeSwitcherPlacement.frame(caret: CGRect(x: 400, y: 10, width: 2, height: 18), size: size, visible: visible)
    check(low.minY == 28 + ScopeSwitcherPlacement.gap, "with no room below, it sits above the line")
    let edge = ScopeSwitcherPlacement.frame(caret: CGRect(x: 1430, y: 500, width: 2, height: 18), size: size, visible: visible)
    check(edge.maxX == 1440, "it stays on screen at the right edge")
    let margined = ScopeSwitcherPlacement.frame(caret: CGRect(x: 400, y: 500, width: 2, height: 18), size: size,
                                                margin: 10, visible: visible)
    check(margined.maxY - 10 == 500 - ScopeSwitcherPlacement.gap && margined.minX + 10 == 400 - ScopeSwitcherPlacement.leadIn,
          "a panel with room for a shadow puts its pill in the same place")
}

print("A backslash prompt is handed to the AI writer chosen with ⌥Tab ↓")
do {
    let tab: Int64 = 48, escape: Int64 = 53
    func key(_ code: Int64, _ flags: CGEventFlags, _ state: KeyRoutingState) -> KeyDecision {
        KeyRouter.decide(keyCode: code, flags: flags, synthetic: false, state: state)
    }
    var choice = WriterChoice()
    check(choice.chosen == .none && choice.writer == nil, "no writer is chosen until one is: a backslash is only a backslash")
    check(choice.entries.first == WriterAgent.none && choice.entries.contains(.chatGPT), "None comes first, then ChatGPT")
    check(choice.index(from: 0, by: 1) == 1 && choice.index(from: choice.entries.count - 1, by: 1) == 0
          && choice.index(from: 0, by: -1) == choice.entries.count - 1, "rolling past the last writer goes back round to None")
    check(choice.choose(at: 1) && choice.writer == .chatGPT && !choice.choose(at: 1), "Return on ChatGPT chooses it, once")
    check(WriterChoice(chosenId: "chatgpt").writer == .chatGPT, "the choice is kept between launches")
    check(WriterChoice(chosenId: "someone-else").writer == nil, "a writer no longer offered reads as None")
    check(WriterAgent.chatGPT.scopeEntry.title == "ChatGPT" && WriterAgent.chatGPT.scopeEntry.projectId == nil,
          "the switcher draws a writer as it draws a folder")

    func prompt(_ text: String) -> String? { WriterPrompt.find(in: text)?.instruction }
    check(prompt("\\Write a message detailing the budget") == "Write a message detailing the budget",
          "a line begun with a backslash is a prompt")
    check(WriterPrompt.find(in: "\\Write a note")?.length == 13, "Tab erases from the backslash to the caret")
    check(prompt("Thanks for the update. \\Summarise the budget") == "Summarise the budget"
          && WriterPrompt.find(in: "Thanks for the update. \\Summarise the budget")?.length == 21,
          "a sentence begun with a backslash is a prompt, and the sentences before it stay")
    check(prompt("First line\n  \\ draft a reply") == "draft a reply", "spaces around the backslash are not part of what is asked")
    check(prompt("\\Write a note. Keep it to two lines") == "Write a note. Keep it to two lines", "a prompt may run to several sentences")
    check(prompt("\\Compare C:\\Users and D:\\Data") == "Compare C:\\Users and D:\\Data", "a backslash inside the prompt is part of it")
    check(prompt("the path is C:\\Users\\adel") == nil && prompt("a\\b") == nil, "a backslash inside a sentence starts no prompt")
    check(prompt("\\") == nil && prompt("\\ ") == nil && prompt("\\a") == nil, "a lone backslash or one letter is not yet a prompt")
    check(prompt("\\\\server\\share") == nil && prompt("\\{bold}") == nil, "a second backslash or a bracket after it is not a prompt")
    check(prompt("\\Write a note\nand then") == nil, "a prompt ends with its line: on the next line it is ordinary text")
    let emoji = WriterPrompt.find(in: "👍 Done. \\Thank them 🙏")
    check(emoji?.instruction == "Thank them 🙏" && emoji?.length == "\\Thank them 🙏".utf16.count, "its length is counted as the field counts it")

    let ready = KeyRoutingState(scopeSwitchAvailable: true, writerPromptReady: true)
    check(key(tab, [], ready) == .swallow(.writePrompt), "Tab on the pill hands the prompt to the writer")
    check(key(escape, [], ready) == .swallow(.dismissWriterPrompt), "Escape puts the pill away")
    check(key(0, [], ready) == .pass(.followTyping(trackCaret: false)), "a letter is typed on into the prompt")
    check(key(tab, .maskShift, ready) != .swallow(.writePrompt), "⇧Tab is still the app's")
    check(key(tab, .maskSecondaryFn, ready) != .swallow(.writePrompt), "fn+Tab is not the prompt's")
    check(key(tab, [], KeyRoutingState(sheetPickerOpen: true, scopeSwitchAvailable: true, writerPromptReady: true))
          != .swallow(.writePrompt), "an open sheet picker keeps Tab")
    check(key(tab, .maskAlternate, ready) == .swallow(.openScopeSwitcher), "⌥Tab still opens the switcher over a prompt")
    check(key(tab, [], KeyRoutingState(scopeSwitchAvailable: true)) == .pass(.followTyping(trackCaret: false)),
          "with no prompt offered, Tab is the app's")
    let working = KeyRoutingState(popup: .hidden, scopeSwitchAvailable: true, writerWorking: true)
    check(key(escape, [], working) == .swallow(.stopWriter), "Escape stops a writer that is answering")
    check(key(0, [], working) == .pass(nil) && key(tab, [], working) == .pass(nil), "its other keys are the app's, and no card follows them")
    check(key(tab, .maskAlternate, working) == .pass(nil), "the switcher waits until the writer is done")

    var lines = WriterLines()
    let first = lines.take(Data("{\"type\":\"text\",\"text\":\"Hi\"}\n{\"type\":\"ci".utf8))
    check(first.count == 1 && String(decoding: first[0], as: UTF8.self) == "{\"type\":\"text\",\"text\":\"Hi\"}",
          "an answer is read a whole line at a time")
    let second = lines.take(Data("te\",\"text\":\"4,200\"}\n\n".utf8))
    check(second.count == 1 && String(decoding: second[0], as: UTF8.self) == "{\"type\":\"cite\",\"text\":\"4,200\"}",
          "a line cut in two waits for its end, and empty lines are skipped")

    var session = [WriterPiece(text: "The total is ", source: nil), WriterPiece(text: "61,750", source: nil),
                   WriterPiece(text: ".\n\n", source: nil)]
    let held = WriterPiece.batch(from: &session, finished: false)
    check(held.map(\.text) == ["The total is ", "61,750", "."] && session.map(\.text) == ["\n\n"],
          "line breaks at the end of what has arrived wait for the words after them")
    var ending = [WriterPiece(text: "Thanks.", source: nil), WriterPiece(text: " \n", source: nil)]
    let last = WriterPiece.batch(from: &ending, finished: true)
    check(last.map(\.text) == ["Thanks."] && ending.isEmpty, "the answer's own last spaces and line breaks are not written")
    var blank = [WriterPiece(text: "\n", source: nil)]
    check(WriterPiece.batch(from: &blank, finished: false).isEmpty && blank.map(\.text) == ["\n"], "with only a line break so far, nothing is written yet")
}

print("Pills sit by an empty field's caret, and the pill's thinking line moves as Kokonut's does")
do {
    let draft = CGRect(x: 72, y: 300, width: 1, height: 520)
    let line = CaretLine.line(draft)
    check(line.minX == 72 && line.minY == 300 && line.height == CaretLine.assumedLineHeight,
          "a caret as tall as an empty Gmail draft stands for its first line, not its bottom edge")
    let caret = CGRect(x: 300, y: 300, width: 2, height: 18)
    check(CaretLine.line(caret) == caret, "a measured caret is kept as it is")
    let below = ScopeSwitcherPlacement.frame(caret: HostGeometryConverter.toAppKit(line, primaryHeight: 900),
                                             size: CGSize(width: 300, height: 44), visible: CGRect(x: 0, y: 0, width: 1440, height: 900))
    check(below.maxY == 900 - 320 - ScopeSwitcherPlacement.gap, "so the switcher sits under the draft's first line")

    let ease = ThinkingMotion.easeOut
    check(ease(0) == 0 && ease(1) == 1 && abs(ease(0.5) - 0.95) < 0.03, "Kokonut's ease-out is most of the way by half time")
    let css = ThinkingMotion.easeInOut
    check(abs(css(0.5) - 0.5) < 0.001 && css(0.1) < 0.1, "ease-in-out is symmetric and starts slowly")
    let scale = ThinkingMotion.scale(forFontSize: 15)
    let first = ThinkingMotion.entering(letter: 0, elapsed: 0, scale: scale, reduceMotion: false)
    check(first.opacity == 0 && first.offset == 4 && first.blur == 2,
          "a letter starts unseen, 8 points low and blurred at 30-point type, half that at 15")
    let risen = ThinkingMotion.entering(letter: 0, elapsed: 0.28, scale: scale, reduceMotion: false)
    check(risen == ThinkingMotion.LetterState(opacity: 1, offset: 0, blur: 0), "it is in place after 0.28 seconds")
    let fifth = ThinkingMotion.entering(letter: 5, elapsed: 0.28, scale: scale, reduceMotion: false)
    check(fifth.opacity < 1 && ThinkingMotion.entering(letter: 5, elapsed: 0.28 + 5 * 0.018, scale: scale, reduceMotion: false).opacity == 1,
          "each letter follows the one before by 0.018 seconds")
    check(ThinkingMotion.entering(letter: 0, elapsed: 0.05, scale: scale, reduceMotion: true).offset == 0,
          "with Reduce Motion letters only fade in")
    let gone = ThinkingMotion.leaving(elapsed: 0.15, scale: 1, reduceMotion: false)
    check(gone.opacity == 0 && gone.offset == -6 && gone.blur == 3, "a replaced line drops out upward in 0.15 seconds")
    check(ThinkingMotion.wave(letter: 0, time: 0, reduceMotion: false) == 1, "the wave starts at full brightness")
    check(abs(ThinkingMotion.wave(letter: 0, time: 0.8, reduceMotion: false) - 0.3) < 0.0001
          && ThinkingMotion.wave(letter: 0, time: 1.6, reduceMotion: false) == 1, "it dims to 0.3 halfway through each 1.6 seconds")
    check(abs(ThinkingMotion.wave(letter: 3, time: 0.8 + 3 * 0.07, reduceMotion: false) - 0.3) < 0.0001,
          "each letter dims 0.07 seconds after the one before, so the wave runs left to right")
    check(ThinkingMotion.wave(letter: 0, time: 0.8, reduceMotion: true) == 1, "with Reduce Motion the letters hold still")

    var lines = ThinkingLines(at: 0)
    check(lines.shown == "Thinking…", "it starts by thinking")
    check(!lines.lookup("Searching for “budget”…", at: 0.7) && lines.shown == "Thinking…",
          "a lookup waits until the line has shown for 1.5 seconds")
    check(lines.advance(at: 1.5) && lines.shown == "Searching for “budget”…", "then it takes its turn")
    check(!lines.lookup("Searching for “budget”…", at: 1.6), "the same lookup again changes nothing")
    check(!lines.lookup("Reading Budget 2026.csv…", at: 2) && lines.advance(at: 3) && lines.shown == "Reading Budget 2026.csv…",
          "lookups are shown one at a time, each for its interval")
    check(!lines.advance(at: 4) && lines.advance(at: 4.5) && lines.shown == "Drafting…",
          "once the last lookup has had its time the writer is drafting")
    check(!lines.advance(at: 9), "and stays drafting until the words arrive")
    check(ThinkingLines.line(status: "searching", detail: "budget, travel costs") == "Searching for “budget”…"
          && ThinkingLines.line(status: "reading", detail: "Finance/Budget 2026.xlsx") == "Reading Budget 2026.xlsx…"
          && ThinkingLines.line(status: "searching", detail: "") == "Searching your files…",
          "lookups are said in plain words, by their first query or the file's name")
    check(ThinkingLines.line(status: "searching", detail: String(repeating: "a", count: 60)).count == 45,
          "a long query is shortened")
}

print("The dictation pill follows the voice and grows into the card")
do {
    check(VoiceLevel.normalized(rms: 0) == 0 && VoiceLevel.normalized(rms: .nan) == 0, "silence and a bad reading draw flat waves")
    check(VoiceLevel.normalized(rms: 0.002) == 0, "a room's hum, below -48 dB, draws flat waves")
    let soft = VoiceLevel.normalized(rms: 0.01), speech = VoiceLevel.normalized(rms: 0.05)
    check(soft > 0.2 && soft < speech && speech < 1, "soft speech moves the waves, and louder speech moves them more")
    check(VoiceLevel.normalized(rms: 0.5) == 1, "a raised voice fills them")

    var waves = VoiceWaveform()
    waves.hear([0.2, 0.9, 0.4])
    waves.advance()
    check(waves.bars.last == 0.9 && waves.bars.count == VoiceWaveform.barCount, "a bar takes the loudest of its two slices")
    waves.advance()
    check(waves.bars.last == 0.4 && waves.bars[VoiceWaveform.barCount - 2] == 0.9, "the waves move left as new bars arrive on the right")
    waves.advance()
    check(abs((waves.bars.last ?? 0) - 0.4 * VoiceWaveform.fade) < 0.0001, "with no reading a bar fades rather than dropping to nothing")
    waves.hear([CGFloat](repeating: 0.5, count: 100))
    var advances = 0
    while waves.bars.last == 0.5 || advances == 0 { waves.advance(); advances += 1; if advances > 50 { break } }
    check(advances == VoiceWaveform.maximumQueued / VoiceWaveform.slicesPerBar + 1,
          "a meter running ahead never leaves the waves far behind the voice")
    let heights = VoiceWaveform().heights(minimum: 3, maximum: 20)
    check(heights.allSatisfy { $0 == 3 }, "in silence every bar is a dot")
    var loud = VoiceWaveform()
    for _ in 0..<VoiceWaveform.barCount { loud.hear([1, 1]); loud.advance() }
    let full = loud.heights(minimum: 3, maximum: 20)
    check(full[VoiceWaveform.barCount / 2] > full[0] && abs(full[0] - full[VoiceWaveform.barCount - 1]) < 0.001 && (full.max() ?? 0) <= 20,
          "the middle bars stand tallest, so the waves sit in the pill as a shape")

    let start = Date(timeIntervalSinceReferenceDate: 1000)
    func at(_ seconds: TimeInterval) -> Date { start.addingTimeInterval(seconds) }
    var session = DictationPillSession()
    check(!session.isOn(at: start), "the pill is not up before dictation")
    session.shortcutPressed(at: start)
    session.shortcutPressed(at: at(0.05))
    check(session.isOn(at: at(1)), "the 🎤 key, which arrives twice, starts dictation once")
    check(!session.isOn(at: at(DictationPillSession.beforeWords + 0.1)), "with no words after the shortcut, the pill goes")
    session.wordsArrived(at: at(12))
    check(session.isOn(at: at(12 + DictationPillSession.afterWords - 0.1))
          && !session.isOn(at: at(12 + DictationPillSession.afterWords + 0.1)),
          "dictated words keep the pill through a pause, then it goes")
    session.shortcutPressed(at: at(40))
    check(!session.isOn(at: at(40.1)) && session.endsAt == nil,
          "after a silence that hid the pill, the shortcut ends dictation rather than starting it")
    session.wordsArrived(at: at(41))
    check(!session.isOn(at: at(41.1)), "the last words dictation writes as it stops do not bring it back")
    session.wordsArrived(at: at(50))
    check(!session.isOn(at: at(50.1)), "after dictation stopped, words alone do not bring the pill back")
    session.shortcutPressed(at: at(51))
    check(session.isOn(at: at(51.1)), "pressing it again starts dictation again")
    session.shortcutPressed(at: at(52))
    check(!session.isOn(at: at(52.1)), "pressing the shortcut while the pill shows stops it")
    session.stop(at: at(53))
    check(!session.isOn(at: at(53)) && session.endsAt == nil, "Escape stops it")
    var unprompted = DictationPillSession()
    unprompted.wordsArrived(at: start)
    check(!unprompted.isOn(at: at(0.1)), "words nobody typed never show the pill without the 🎤 key")
    var paused = DictationPillSession()
    paused.shortcutPressed(at: start)
    paused.wordsArrived(at: at(2))
    paused.wordsArrived(at: at(30))
    check(paused.isOn(at: at(30.1)), "words after a pause bring the pill back in a dictation the 🎤 key started")
    paused.wordsArrived(at: at(30 + DictationPillSession.dictationMemory + 1))
    check(!paused.isOn(at: at(30 + DictationPillSession.dictationMemory + 1.1)), "a minute after the last words, words alone do not")
    var later = DictationPillSession()
    later.shortcutPressed(at: start)
    later.wordsArrived(at: at(2))
    later.shortcutPressed(at: at(2 + DictationPillSession.dictationMemory + 1))
    check(later.isOn(at: at(2 + DictationPillSession.dictationMemory + 1.1)),
          "a minute after the last words, the shortcut starts dictation again")

    let visible = CGRect(x: 0, y: 0, width: 1440, height: 900)
    let pill = CGSize(width: 132, height: 36)
    let caret = CGRect(x: 600, y: 300, width: 2, height: 18)
    let under = DictationPillPlacement.frame(caret: caret, size: pill, visible: visible)
    // macOS's microphone as measured on screen: 30 by 23 points, centred on the caret, 5 points under the line.
    let microphone = CGRect(x: caret.midX - 15, y: caret.minY - 28, width: 30, height: 23)
    check(under.maxY == caret.minY - DictationPillPlacement.underLine && under.minX > microphone.maxX
          && !under.intersects(microphone) && abs(under.midY - microphone.midY) <= 3,
          "the pill sits just under the caret line, level with macOS's microphone and to its right")
    let nextWord = caret.offsetBy(dx: 50, dy: 0)
    let lead = DictationPillPlacement.lead(from: caret, to: nextWord, keeping: 0)
    let ahead = DictationPillPlacement.frame(caret: nextWord, size: pill, visible: visible, lead: lead)
    check(lead == 50 && !ahead.intersects(microphone.offsetBy(dx: 100, dy: 0)),
          "while words arrive the pill keeps a word ahead, so the next word does not put the microphone under it")
    check(DictationPillPlacement.lead(from: nextWord, to: nextWord.offsetBy(dx: 3, dy: 0), keeping: 50) == 50
          && DictationPillPlacement.lead(from: caret, to: caret.offsetBy(dx: 400, dy: 0), keeping: 0) == DictationPillPlacement.longestLead,
          "a step too short to be a word keeps the lead, and a long jump keeps no more than a long word")
    check(DictationPillPlacement.lead(from: nextWord, to: caret, keeping: 50) == 0
          && DictationPillPlacement.lead(from: caret, to: caret.offsetBy(dx: -300, dy: -22), keeping: 50) == 0,
          "going back, or onto a new line, keeps no lead")
    let bottom = CGRect(x: 600, y: 20, width: 2, height: 18)
    check(DictationPillPlacement.frame(caret: bottom, size: pill, visible: visible).minY == bottom.maxY + DictationPillPlacement.gap,
          "with no room under the line, it sits above")
    let edge = CGRect(x: 1400, y: 300, width: 2, height: 18)
    let atEdge = DictationPillPlacement.frame(caret: edge, size: pill, visible: visible)
    check(atEdge.maxX < edge.midX - DictationPillPlacement.microphoneHalfWidth && atEdge.maxX <= 1440,
          "at the right edge of the screen, it sits before the microphone instead")

    // CoreAudio's transport codes: built in, Bluetooth, USB.
    func transport(_ code: String) -> UInt32 { code.utf8.reduce(0) { $0 << 8 | UInt32($1) } }
    let builtIn = MeterInput(uid: "BuiltInMic", transport: transport("bltn"))
    let airPods = MeterInput(uid: "AirPods", transport: transport("blue"))
    let usb = MeterInput(uid: "USBMic", transport: transport("usb "))
    check(MeterInput.choose([airPods, builtIn], defaultInput: "AirPods") == "BuiltInMic",
          "the waves listen through the Mac's own microphone, never the headset Dictation uses")
    check(MeterInput.choose([usb, airPods], defaultInput: "USBMic") == "USBMic",
          "without one, a wired microphone that is the input")
    check(MeterInput.choose([airPods], defaultInput: "AirPods") == nil,
          "with only a headset, the waves do not listen at all")

    let capsule = DictationOutline.pill(CGRect(x: 100, y: 100, width: 132, height: 36), caretX: 166, pointerAtTop: false)
    check(capsule.cornerRadius == 18 && capsule.pointerHeight == 0 && capsule.pointerX == 66,
          "the pill is a capsule whose arrow lies flat under the caret")
    let seed = DictationOutline.seed(of: capsule)
    check(seed.rect.width == 36 && seed.rect.midX == capsule.rect.midX, "it grows out of a dot at its centre")
    let cardOutline = DictationOutline(rect: CGRect(x: 0, y: 0, width: 760, height: 396), cornerRadius: 18,
                                       pointerHeight: 12, pointerWidth: 21, pointerX: 84, pointerAtTop: false)
    check(DictationOutline.between(capsule, cardOutline, progress: 0) == capsule
          && DictationOutline.between(capsule, cardOutline, progress: 1) == cardOutline,
          "the morph starts at the pill and ends at the card's own outline")
    let halfway = DictationOutline.between(capsule, cardOutline, progress: 0.5)
    check(halfway.pointerHeight == 6 && halfway.rect.width == 446, "on the way the arrow grows as the outline widens")
    let past = DictationOutline.between(cardOutline, capsule, progress: 1.1)
    check(past.pointerHeight == 0 && past.pointerWidth == 0 && past.rect.width >= 1,
          "a spring overshooting back into the pill never turns the arrow inside out")

    let canvas = DictationMorphCanvas.covering([CGRect(x: 100, y: 100, width: 132, height: 36), CGRect(x: 50, y: 150, width: 760, height: 396)],
                                               margin: 18)
    check(canvas.frame == CGRect(x: 32, y: 82, width: 796, height: 482), "the morph's panel covers both ends with room for a shadow")
    let local = canvas.local(CGRect(x: 100, y: 100, width: 132, height: 36))
    check(local.minX == 68 && local.maxY == 482 - 18 && canvas.appKit(local) == CGRect(x: 100, y: 100, width: 132, height: 36),
          "the panel draws from its top-left, and its rectangles go back to the screen unchanged")

    let fade = DictationFade(from: 0, to: 1, delay: 0.1, duration: 0.2)
    check(fade.value(at: 0) == 0 && fade.value(at: 0.31) == 1 && fade.value(at: 0.2) > 0.5,
          "a fade waits, then eases out to where it lands")
    check(!fade.isDone(at: 0.29) && fade.isDone(at: 0.31) && DictationFade.hold(0.4).value(at: 0) == 0.4,
          "it is done once its time is up, and a held opacity stays")
}

do {
    check(GhostMotion.letter == (stiffness: 300, damping: 30) && GhostMotion.hop == (stiffness: 520, damping: 16)
          && GhostMotion.tabKey == (stiffness: 520, damping: 24)
          && GhostMotion.offerStagger == 0.008 && GhostMotion.acceptStagger == 0.016
          && GhostMotion.hopVelocity == -70 && GhostMotion.keyDropVelocity == -9 && GhostMotion.brighten == 0.18,
          "ghost text moves on the Ghost Suggestion component's own springs and timing")

    // What Tab would add after the caret.
    check(GhostLayout.remainder(of: CompletionPlan(range: 8..<11, expectedPrefix: "sup", insertText: "supplies")) == "plies",
          "the ghost is the rest of the word being typed")
    check(GhostLayout.remainder(of: CompletionPlan(range: 0..<10, expectedPrefix: "office sup", insertText: "Office supplies")) == "plies",
          "typed letters in another case still count as typed")
    check(GhostLayout.remainder(of: CompletionPlan(range: 12..<12, expectedPrefix: "", insertText: " $400")) == " $400",
          "a value added after the typed words keeps the space Tab writes before it")
    check(GhostLayout.remainder(of: CompletionPlan(range: 20..<25, expectedPrefix: "suppl", insertText: "Office supplies")) == nil,
          "no ghost when Tab would rewrite the typed letters into something else")
    check(GhostLayout.remainder(of: CompletionPlan(range: 0..<15, expectedPrefix: "Office supplies", insertText: "Office supplies")) == nil,
          "no ghost when Tab would add nothing")

    // What fits on the caret's line.
    let tenEach: (String) -> CGFloat = { CGFloat($0.count) * 10 }
    check(GhostLayout.fit("plies for the office", width: 200, measure: tenEach) == "plies for the office", "a ghost that fits shows whole")
    check(GhostLayout.fit("plies for the office", width: 120, measure: tenEach) == "plies for\u{2026}",
          "a long ghost is cut after the last whole word that fits")
    check(GhostLayout.fit("plies\nNext line", width: 500, measure: tenEach) == "plies\u{2026}", "a ghost stops at the end of its line")
    check(GhostLayout.fit("supercalifragilistic", width: 50, measure: tenEach) == nil, "no ghost when not one word fits")
    check(GhostLayout.fit("   ", width: 500, measure: tenEach) == nil, "no ghost of only spaces")

    func run(_ ghost: inout GhostLetters, seconds: Double, watch: (GhostLetters) -> Void = { _ in }) {
        for _ in 0..<Int(seconds * 60) { ghost.advance(by: 1.0 / 60); watch(ghost) }
    }

    var ghost = GhostLetters(text: "plies for", keyPops: true)
    check(ghost.count == 9 && ghost.opacity(at: 0) == 0 && ghost.keyFace.opacity == 0 && abs(ghost.keyFace.scale - 0.6) < 0.0001,
          "the ghost starts unseen, its Tab key small")
    run(&ghost, seconds: 0.05)
    check(ghost.opacity(at: 0) > 0.2 && ghost.opacity(at: 0) > ghost.opacity(at: 8), "its letters fade in from left to right")
    var widest = 0.0
    run(&ghost, seconds: 1.5) { widest = max(widest, $0.keyFace.scale) }
    check(widest > 1 && widest <= 1.08, "the Tab key pops a little past its size")
    check(!ghost.isMoving && ghost.opacity(at: 8) == 1 && ghost.keyFace.opacity == 1 && ghost.keyFace.scale == 1
          && ghost.brightness(at: 0) == 0 && !ghost.hasLanded,
          "then the ghost rests, dim, with its Tab key beside it")

    let swapped = GhostLetters(text: "budget", keyPops: false)
    check(swapped.opacity(at: 0) == 0 && swapped.keyFace.opacity == 1 && swapped.keyFace.scale == 1,
          "another suggestion's ghost fades in beside a Tab key already there")

    ghost.accept()
    run(&ghost, seconds: 0.05)
    check(ghost.brightness(at: 0) > ghost.brightness(at: 8), "Tab brightens the letters from left to right")
    var highest = 0.0
    run(&ghost, seconds: 1.5) { highest = max(highest, $0.lift(at: 4)) }
    check(highest > 1 && highest < 4, "each letter makes a small hop")
    check(ghost.hasLanded && abs(ghost.lift(at: 4)) < 0.01 && ghost.brightness(at: 8) == 1 && ghost.keyFace.opacity == 0,
          "and lands bright as the Tab key goes")

    var calm = GhostLetters(text: "plies", keyPops: true, reduceMotion: true)
    var calmWidest = 0.0
    run(&calm, seconds: 1.5) { calmWidest = max(calmWidest, $0.keyFace.scale) }
    calm.accept()
    var lowest = 0.0
    run(&calm, seconds: 1.5) { lowest = min(lowest, $0.lift(at: 2)) }
    check(calmWidest <= 1 && lowest > -0.01 && calm.hasLanded, "with Reduce Motion nothing overshoots")
}

do {
    // The Toggle Switch component's knob: it stretches toward where it is
    // going, lands with a small bounce and rounds back up.
    let motion = SwitchMotion()
    motion.set(on: false, animated: true)
    check(!motion.isMoving && motion.knob(diameter: 26, travel: 20) == (0, 26), "a switch first shown rests where it is")
    motion.set(on: true, animated: true)
    var clock = 0.0
    var longest = 0.0, furthest = 0.0, frontAtStart = 0.0
    motion.advance(to: clock)
    while clock < 2 {
        clock += 1.0 / 60
        motion.advance(to: clock)
        let knob = motion.knob(diameter: 26, travel: 20)
        if clock < 0.05 { frontAtStart = knob.x + knob.width }
        longest = max(longest, knob.width)
        furthest = max(furthest, motion.position.x)
    }
    check(frontAtStart > 26.5, "flipping on, the knob's front edge leads")
    check(longest > 35 && longest <= 36, "the knob grows up to ten points longer on the way")
    check(furthest > 1.05 && furthest < 1.3, "and lands with a small bounce")
    check(!motion.isMoving && motion.knob(diameter: 26, travel: 20) == (20, 26), "then rests round at the far end")
    motion.set(on: false, animated: false)
    check(!motion.isMoving && motion.progress == 0, "a flip that is not animated lands at once")
    check(SwitchMotion.kept(for: "header") === SwitchMotion.kept(for: "header"), "a rebuilt switch keeps its motion by key")
}

print("reconciling stale web AXValue against live markers and contenteditable leaves")
do {
    let emptyWebLeaves = WebTextReader.ContentEditableLeafState(hasContentChildren: true, leafTexts: [])
    let nativeLeaves = WebTextReader.ContentEditableLeafState(hasContentChildren: false, leafTexts: nil)
    let placeholder = "Ask anything, @ to mention, / for actions"
    let staleValue = "Invoice for BILL-1160"

    check(WebTextReader.reconcileTextValue(axValue: staleValue, placeholder: placeholder,
                                           markerText: "\n", leaves: emptyWebLeaves) == .empty,
          "a newline-only marker range from an emptied rich editor overrides a stale AXValue")
    check(WebTextReader.reconcileTextValue(axValue: staleValue, placeholder: nil,
                                           markerText: " \u{200B}\u{00A0}\n ", leaves: nil) == .empty,
          "zero-width and whitespace-only marker text is treated as an empty editor")
    check(WebTextReader.reconcileTextValue(axValue: staleValue, placeholder: nil,
                                           markerText: nil, leaves: emptyWebLeaves) == .empty,
          "a contenteditable whose live text leaves are empty overrides a stale AXValue even without markers")
    check(WebTextReader.reconcileTextValue(axValue: staleValue, placeholder: placeholder,
                                           markerText: placeholder, leaves: emptyWebLeaves) == .empty,
          "marker text showing only the editor placeholder is treated as empty")
    check(WebTextReader.reconcileTextValue(axValue: staleValue, placeholder: nil,
                                           markerText: nil,
                                           leaves: .init(hasContentChildren: true, leafTexts: [placeholder]))
          == .stale(liveText: placeholder),
          "placeholder leaves that contradict a stale AXValue replace it so old highlights disappear")
    check(WebTextReader.reconcileTextValue(axValue: staleValue, placeholder: nil,
                                           markerText: "Invoice",
                                           leaves: .init(hasContentChildren: true, leafTexts: ["Invoice"]))
          == .stale(liveText: "Invoice"),
          "partial deletions reported by live markers supersede a stale AXValue")
    check(WebTextReader.reconcileTextValue(axValue: "Invoice\u{00A0}@file\nBILL-1160", placeholder: nil,
                                           markerText: "Invoice @file BILL-1160",
                                           leaves: .init(hasContentChildren: true, leafTexts: ["Invoice ", " BILL-1160"]))
          == .use("Invoice\u{00A0}@file\nBILL-1160"),
          "a live contenteditable with non-breaking spaces, line breaks and inline chips keeps its AXValue")
    check(WebTextReader.reconcileTextValue(axValue: staleValue, placeholder: placeholder,
                                           markerText: nil, leaves: nativeLeaves)
          == .use(staleValue),
          "native controls without web children keep their AXValue untouched")

    check(!WebTextReader.liveWebTextContains(phrase: "Invoice", markerText: "\n", leaves: emptyWebLeaves)
          && !WebTextReader.liveWebTextContains(phrase: "BILL-1160", markerText: nil, leaves: emptyWebLeaves)
          && !WebTextReader.liveWebTextContains(phrase: "BILL-1160", markerText: nil,
                                                leaves: .init(hasContentChildren: true, leafTexts: ["Invoice "])),
          "layout inference is blocked when live markers or contenteditable leaves no longer hold the phrase")
    check(WebTextReader.liveWebTextContains(phrase: "Invoice", markerText: nil,
                                            leaves: .init(hasContentChildren: true, leafTexts: ["Inv", "oice"]))
          && WebTextReader.liveWebTextContains(phrase: "Hello World", markerText: nil,
                                               leaves: .init(hasContentChildren: true, leafTexts: ["Hello", "World"]))
          && WebTextReader.liveWebTextContains(phrase: "Invoice", markerText: nil, leaves: nativeLeaves),
          "live text checks accept phrases spanning inline leaves, paragraphs and native editors")
}

print(failures == 0 ? "\(checks) checks passed" : "\(failures) of \(checks) checks FAILED")
exit(failures == 0 ? 0 : 1)
