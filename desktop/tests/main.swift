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
    let excerpt = SharePDFExcerpt(text: "A selected sentence.", regions: [region])
    check((excerpt.payload["regions"] as? [[String: Any]])?.first?["page"] as? Int == 3,
          "PDF excerpt payloads preserve the reviewed page region")
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

    var shortcut = DictationShortcut()
    check(shortcut.keyDown(176, flags: []) && shortcut.keyDown(176, flags: .maskSecondaryFn)
          && !shortcut.keyDown(176, flags: .maskCommand) && !shortcut.keyDown(96, flags: [])
          && !shortcut.keyDown(0, flags: []),
          "the 🎤 key starts Dictation, alone or with fn; ⌘🎤, F5 and letters do not")
    func taps(_ steps: [(CGEventFlags, TimeInterval)]) -> [Bool] {
        var detector = DictationShortcut()
        return steps.map { detector.flagsChanged($0.0, at: $0.1) }
    }
    check(taps([(.maskSecondaryFn, 0), ([], 0.08), (.maskSecondaryFn, 0.2), ([], 0.28)]) == [false, false, false, true]
          && taps([(.maskControl, 0), ([], 0.1), (.maskControl, 0.2), ([], 0.3)]).last == true
          && taps([(.maskCommand, 0), ([], 0.1), (.maskCommand, 0.25), ([], 0.35)]).last == true,
          "fn, Control or Command pressed twice is a Dictation shortcut")
    check(taps([(.maskSecondaryFn, 0), ([], 0.1), (.maskSecondaryFn, 0.7), ([], 0.8)]).last == false
          && taps([(.maskSecondaryFn, 0), ([], 0.1), (.maskControl, 0.2), ([], 0.3)]).last == false
          && taps([(.maskShift, 0), ([], 0.1), (.maskShift, 0.2), ([], 0.3)]).last == false
          && taps([(.maskCommand, 0), ([.maskCommand, .maskShift], 0.05), ([], 0.1), (.maskCommand, 0.2), ([], 0.3)]).last == false,
          "slow taps, two different modifiers, Shift and chords are not")
    var typedBetween = DictationShortcut()
    _ = typedBetween.flagsChanged(.maskCommand, at: 0)
    _ = typedBetween.flagsChanged([], at: 0.1)
    _ = typedBetween.keyDown(8, flags: [])
    _ = typedBetween.flagsChanged(.maskCommand, at: 0.2)
    check(!typedBetween.flagsChanged([], at: 0.3), "a key typed between the taps breaks the shortcut")

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

print("")
print("Notch display eligibility and geometry")
let notchLeft = NSRect(x: 0, y: 0, width: 650, height: 32)
let notchRight = NSRect(x: 850, y: 0, width: 650, height: 32)
check(NotchGeometry.supported(builtIn: true, topInset: 32, left: notchLeft, right: notchRight), "offers notch controls for a built-in camera cutout")
check(!NotchGeometry.supported(builtIn: false, topInset: 32, left: notchLeft, right: notchRight), "hides notch controls on external displays")
check(!NotchGeometry.supported(builtIn: true, topInset: 0, left: notchLeft, right: notchRight), "hides notch controls on MacBooks without a cutout")
check(!NotchGeometry.supported(builtIn: true, topInset: 32, left: nil, right: nil), "safe-area inset alone cannot enable notch controls")
check(!NotchGeometry.supported(builtIn: true, topInset: 32, left: notchLeft, right: notchLeft), "requires a real gap between auxiliary menu areas")
let notchScreen = NSRect(x: -1700, y: -1100, width: 1500, height: 1000)
let notchFrame = NotchGeometry.frame(screen: notchScreen, topInset: 32, centerX: -950, expanded: true)
check(notchFrame.maxY == notchScreen.maxY && notchFrame.height == 230, "black notch surface reaches the display edge and reserves the camera band")
check(notchFrame.midX == -950 && notchScreen.contains(notchFrame), "notch follows a secondary display with negative coordinates")
let notchCompact = NotchGeometry.frame(screen: notchScreen, topInset: 32, centerX: -950, expanded: false)
check(notchCompact == NSRect(x: -1050, y: -132, width: 200, height: 32), "collapsed hit target exactly covers the physical camera housing without a logo extension")
let wideNotch = NotchGeometry.frame(screen: notchScreen, topInset: 32, centerX: -950, expanded: false, notchWidth: 250)
check(wideNotch.minX == -1075 && wideNotch.maxX == -825 && wideNotch.midX == -950,
      "the full left, middle and right of a wider camera housing remain clickable")
check(wideNotch.height == 32 && notchScreen.contains(wideNotch), "collapsed surface remains within the camera band")
let wideExpandedNotch = NotchGeometry.frame(screen: notchScreen, topInset: 32, centerX: -950, expanded: true, notchWidth: 500)
let wideCompactNotch = NotchGeometry.frame(screen: notchScreen, topInset: 32, centerX: -950, expanded: false, notchWidth: 500)
check(wideExpandedNotch.contains(wideCompactNotch) && wideExpandedNotch.midX == wideCompactNotch.midX,
      "expanded content remains centered around an unusually wide camera cutout")
let notchNotice = NotchGeometry.frame(screen: notchScreen, topInset: 32, centerX: -950, expanded: true, contentHeight: 92)
check(notchNotice.height == 124 && notchNotice.height < notchFrame.height && notchNotice.maxY == notchFrame.maxY,
      "source notifications form a compact popup attached to the same top edge")
let shortNotchScreen = NSRect(x: 200, y: 1200, width: 900, height: 180)
let boundedNotch = NotchGeometry.frame(screen: shortNotchScreen, topInset: 32, centerX: 650, expanded: true, contentHeight: 500)
check(shortNotchScreen.contains(boundedNotch) && boundedNotch.minY == shortNotchScreen.minY + 12,
      "an expanded notch fits a short display above the primary screen")

print("Notch linked-source activity")
let linkedNotchChange: [String: Any] = ["projectId": "one", "objectId": "cell", "toVersion": 3, "referenceCount": 1]
let notchActivity = NotchActivity(["directories": -1, "changes": [linkedNotchChange]])
check(notchActivity.directories == 0 && notchActivity.newestKey == "one:cell:3", "activity uses source identity and clamps invalid counts")
check(NotchActivity().newestKey == nil, "an empty workspace has no fabricated notification")
check(!notchActivity.hasNewActivity(comparedTo: notchActivity), "unchanged source history cannot reopen the notch")
check(NotchActivity(["failures": 1]).hasNewActivity(comparedTo: NotchActivity()), "new indexing failures trigger the notch")
check(!NotchActivity().hasNewActivity(comparedTo: NotchActivity(["failures": 1])), "resolved issues do not trigger an interruption")
let newerLinkedNotchChange: [String: Any] = ["projectId": "one", "objectId": "cell", "toVersion": 4, "referenceCount": 1]
check(NotchActivity(["changes": [newerLinkedNotchChange]]).hasNewActivity(comparedTo: notchActivity),
      "a new pinned linked-source version triggers the notch with an older server response")
let unlinkedNotchChange: [String: Any] = ["projectId": "one", "objectId": "unlinked", "toVersion": 8, "referenceCount": 0]
check(!NotchActivity(["changes": [unlinkedNotchChange]]).hasNewActivity(comparedTo: NotchActivity()),
      "an unrelated source change does not interrupt the user")
let nativeNotchActivity = NotchActivity(["changes": [unlinkedNotchChange], "linkedChanges": [newerLinkedNotchChange]])
check(nativeNotchActivity.hasNewActivity(comparedTo: notchActivity)
      && nativeNotchActivity.changeKeys == Set(["one:cell:4"]),
      "native linked-source changes trigger even when absent from the recent-change summary")
check(!NotchActivity(["changes": [newerLinkedNotchChange], "linkedChanges": [[String: Any]]()])
    .hasNewActivity(comparedTo: NotchActivity()), "an explicit empty linked-change response takes precedence over the general summary")
let otherLinkedNotchChange: [String: Any] = ["projectId": "two", "objectId": "cell", "toVersion": 4]
check(NotchActivity(["linkedChanges": [otherLinkedNotchChange]]).hasNewActivity(comparedTo: nativeNotchActivity),
      "source versions in different directories keep separate identities")
check(!NotchActivity(["linkedChanges": [otherLinkedNotchChange, newerLinkedNotchChange]])
    .hasNewActivity(comparedTo: NotchActivity(["linkedChanges": [newerLinkedNotchChange, otherLinkedNotchChange]])),
      "reordering linked changes does not produce a duplicate notification")
check(!NotchActivity().hasNewActivity(comparedTo: nativeNotchActivity),
      "removing a link or resolving its change does not fabricate fresh activity")
let manyNotchChanges = (0..<12).map { ["projectId": "one", "objectId": "cell-\($0)", "toVersion": 2] as [String: Any] }
let crowdedNotchActivity = NotchActivity(["changes": manyNotchChanges, "linkedChanges": manyNotchChanges])
check(crowdedNotchActivity.changes.count == 8 && crowdedNotchActivity.changeKeys.contains("one:cell-11:2"),
      "linked-source detection remains complete beyond the eight visible history rows")

print("")
print("Notch motion")
func runSpring(_ spring: NotchSpring, _ style: NotchSpringStyle, seconds: Double, hertz: Double = 120) -> (end: NotchSpring, low: CGFloat, high: CGFloat) {
    var current = spring, low = spring.value, high = spring.value
    for _ in 0..<Int(seconds * hertz) {
        current = current.advanced(by: 1 / hertz, style: style)
        low = min(low, current.value); high = max(high, current.value)
    }
    return (current, low, high)
}
let springOpen = runSpring(NotchSpring(0, target: 100), .open, seconds: 1)
check(springOpen.end.isSettled(within: 0.5) && springOpen.high > 104 && springOpen.high < 110,
      "opening springs visibly past its size and settles within a second")
let springClose = runSpring(NotchSpring(100, target: 0), .close, seconds: 1)
check(springClose.end.isSettled(within: 0.5) && springClose.low > -0.01,
      "closing settles into the housing without bouncing past it")
let springMidway = runSpring(NotchSpring(0, target: 100), .open, seconds: 0.05).end
let springTurned = springMidway.retargeted(to: 0).advanced(by: 1.0 / 120, style: .close)
check(springMidway.velocity > 0 && springTurned.value > springMidway.value,
      "reversing mid-flight keeps the surface's momentum, so it turns rather than jumps")
let springAt60 = runSpring(NotchSpring(0, target: 100), .open, seconds: 0.2, hertz: 60).end
let springAt120 = runSpring(NotchSpring(0, target: 100), .open, seconds: 0.2, hertz: 120).end
check(abs(springAt60.value - springAt120.value) < 0.5, "the same motion plays on 60 and 120 Hz displays")
check(NotchSpring(5).advanced(by: 0.5, style: .open).value == 5, "a spring at rest on its target stays put")
let motionCamera = NSRect(x: -1050, y: -132, width: 200, height: 32)
var bodyMotion = NotchBodyMotion(from: motionCamera, to: notchFrame)
for _ in 0..<6 { bodyMotion = bodyMotion.advanced(by: 1.0 / 120, style: .open) }
check(abs(bodyMotion.frame.maxY - notchScreen.maxY) < 0.001 && bodyMotion.frame.height > 32 && bodyMotion.frame.height < notchFrame.height,
      "the body grows down from the display edge")
check(abs(bodyMotion.frame.midX - motionCamera.midX) < 0.01, "the body stays centered on the camera housing as it widens")
for _ in 0..<120 { bodyMotion = bodyMotion.advanced(by: 1.0 / 120, style: .open) }
check(bodyMotion.isSettled && abs(bodyMotion.frame.height - notchFrame.height) < 0.5 && bodyMotion.target == notchFrame,
      "the body settles on its expanded frame")
let bodyRetargeted = bodyMotion.retargeted(to: motionCamera)
check(bodyRetargeted.frame == bodyMotion.frame && bodyRetargeted.target == motionCamera && !bodyRetargeted.isSettled,
      "closing starts from where the body is")
let motionWindow = NotchGeometry.motionFrame(screen: notchScreen, compact: notchCompact, from: motionCamera, to: notchFrame)
check(motionWindow.contains(notchCompact) && motionWindow.contains(motionCamera) && motionWindow.contains(notchFrame)
      && notchScreen.contains(motionWindow) && motionWindow == motionWindow.integral,
      "one window frame holds the housing and the whole transition, on whole points")
check(motionWindow.minY <= notchFrame.minY - NotchGeometry.overshootAllowance
      && motionWindow.maxX >= notchFrame.maxX + NotchGeometry.overshootAllowance,
      "the transition window leaves room for the opening overshoot")

print("synthetic typing chunks")
let accented = String(repeating: "e\u{301}", count: 12) + "👩‍🔬 Café"
let accentedChunks = accented.chunkedForTyping(16)
check(accentedChunks.allSatisfy { $0.utf16.count <= 16 }, "every typing chunk fits the per-event UTF-16 limit")
check(accentedChunks.joined() == accented, "chunking keeps decomposed accents and emoji intact")
check(SyntheticKeyboard.canType("office supplies are up 4%"), "a phrase is typed where the host ignores Accessibility writes")
check(["\n    allowed = [", "range(31)]\n", "a\r\nb", "one\u{2028}two"].allSatisfy { !SyntheticKeyboard.canType($0) },
      "text with a line break is pasted, never typed: typed line breaks arrived out of order in the Claude app")
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
    func owner(of editor: Node, named reported: Node, maxDepth: Int = AssistPopupHost.maxWindowDepth) -> Node? {
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
    let native = bundle("Native", framework: "Sparkle", resource: "Info.plist")
    check(HostAccessibilityMode.isChromiumBased(bundleURL: browser), "detects a Chromium framework bundle")
    check(HostAccessibilityMode.isChromiumBased(bundleURL: versioned), "detects a versioned framework layout")
    check(!HostAccessibilityMode.isChromiumBased(bundleURL: native), "a native app is not Chromium")
    check(!HostAccessibilityMode.isChromiumBased(bundleURL: nil), "an app without a bundle is not Chromium")
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

print(failures == 0 ? "\(checks) checks passed" : "\(failures) of \(checks) checks FAILED")
exit(failures == 0 ? 0 : 1)
