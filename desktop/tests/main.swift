//  Native regression tests for insertion, dependency anchoring, and geometry.
//  Built and run by `npm run desktop:test` — no framework, no dependencies.

import Cocoa
import PDFKit
import CoreText

var failures = 0
var checks = 0

final class MemoryDirectoryDefaults: UserDefaults {
    var values: [String: Any] = [:]
    override func dictionary(forKey defaultName: String) -> [String: Any]? {
        values[defaultName] as? [String: Any]
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
    func finishPaste() { RunLoop.current.run(until: Date().addingTimeInterval(0.7)) }
    copy("Original clipboard")
    RichTextInserter.withBorrowedPasteboard(pasteboard) { copy("First link") }
    finishPaste()
    check(pasteboard.string(forType: .string) == "Original clipboard",
          "sharing restores the original clipboard after the paste")
    RichTextInserter.withBorrowedPasteboard(pasteboard) { copy("Second link") }
    copy("Newly copied text")
    finishPaste()
    check(pasteboard.string(forType: .string) == "Newly copied text",
          "a copy made during sharing is never overwritten")
    RichTextInserter.withBorrowedPasteboard(pasteboard) { copy("Third link") }
    RichTextInserter.withBorrowedPasteboard(pasteboard) { copy("Fourth link") }
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
    check(String(data: formats[.string]!, encoding: .utf8)!.contains(url.absoluteString),
          "plain-text email fallback keeps the URL")
    let rtf = try! NSAttributedString(data: formats[.rtf]!, options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil)
    check(rtf.string == "Supplies & <cost>", "native rich-text paste preserves the label")
    check(rtf.attribute(.link, at: 0, effectiveRange: nil) != nil, "native rich-text paste retains a clickable link")
    check(RichTextInserter.containsLink(rtf, to: url), "read-back rich text proves the expected share destination")
    check(!RichTextInserter.containsLink(NSAttributedString(string: rtf.string), to: url),
          "a matching label without a hyperlink cannot confirm a share")
    check(!RichTextInserter.containsLink(rtf, to: URL(string: "https://example.test/wrong")!),
          "a hyperlink to another destination cannot confirm a share")
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
        claimType: "ENTITY", label: "Bad Debts/Losses and Thefts", value: "25") ==
          "Bad Debts/Losses and Thefts",
          "an entity claim inserts the indexed row name instead of a child cell value")
    check(AssistSuggestionSemantics.insertionText(
        claimType: "QUANTITATIVE", label: "Bad Debts/Losses and Thefts · Current Period", value: "25") == "25",
          "a quantitative claim still inserts the source-backed value")
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
check(notchCompact.height == 32 && notchCompact.maxY == notchFrame.maxY, "collapsed logo stays entirely inside the menu bar")
let wideNotch = NotchGeometry.frame(screen: notchScreen, topInset: 32, centerX: -950, expanded: false, notchWidth: 250)
check(wideNotch.minX + NotchGeometry.logoWidth == -1075, "logo sits immediately left of the physical notch")
check(wideNotch.maxX == -1075 + 32, "compact black backing fills the rounded housing corner")
check(wideNotch.maxX < -950 && notchScreen.contains(wideNotch), "compact overlap stays beneath the housing without extending beyond the screen")
let wideExpandedNotch = NotchGeometry.frame(screen: notchScreen, topInset: 32, centerX: -950, expanded: true, notchWidth: 500)
let wideCompactNotch = NotchGeometry.frame(screen: notchScreen, topInset: 32, centerX: -950, expanded: false, notchWidth: 500)
check(wideExpandedNotch.minX <= wideCompactNotch.minX && wideExpandedNotch.maxX > -700, "expanded panel keeps the logo visible beside unusually wide camera cutouts")
let notchActivity = NotchActivity(["directories": -1, "changes": [["projectId": "one", "objectId": "cell", "toVersion": 3]]])
check(notchActivity.directories == 0 && notchActivity.newestKey == "one:cell:3", "activity uses source identity and clamps invalid counts")
check(NotchActivity().newestKey == nil, "an empty workspace has no fabricated notification")
check(!notchActivity.hasNewActivity(comparedTo: notchActivity), "unchanged source history cannot reopen the notch")
check(NotchActivity(["failures": 1]).hasNewActivity(comparedTo: NotchActivity()), "new indexing failures trigger the notch")
check(!NotchActivity().hasNewActivity(comparedTo: NotchActivity(["failures": 1])), "resolved issues do not trigger an interruption")
check(NotchActivity(["changes": [["projectId": "one", "objectId": "cell", "toVersion": 4]]]).hasNewActivity(comparedTo: notchActivity), "a new pinned source version triggers the notch")

print(failures == 0 ? "\(checks) checks passed" : "\(failures) of \(checks) checks FAILED")
exit(failures == 0 ? 0 : 1)
