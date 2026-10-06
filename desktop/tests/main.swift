//  Pure-logic tests for dependency anchoring and geometry.
//  Built and run by `npm run desktop:test` — no framework, no dependencies.

import Cocoa

var failures = 0
var checks = 0

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
func accept(_ before: String, insert: String, caret: Int? = nil)
    -> (after: String, range: Range<Int>?, failure: CompletionFailure?) {
    let document = units(before)
    let position = caret ?? document.count
    guard case .success(let plan) = CompletionTransaction.plan(
        document: document, caret: position, insertText: insert) else {
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

print("a completion can never delete more than it inserts")
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


print("calibrated Chrome text layout")
do {
    let font = NSFont.systemFont(ofSize: 14)
    let value = "The expected cost of supplies"
    let attributed = NSAttributedString(string: value, attributes: [.font: font])
    let valueUnits = Array(value.utf16)
    let phrase = Array("supplies".utf16)
    guard let start = TextAnchorResolver.indices(of: phrase, in: valueUnits).first else {
        check(false, "finds the accepted phrase"); exit(1)
    }
    let range = start..<(start + phrase.count)
    let frame = CGRect(x: 1_000, y: 500, width: 500, height: 24)
    let padding: CGFloat = 5
    let caretWidth = attributed.size().width
    let actualCaret = CGRect(x: frame.minX + padding + caretWidth, y: frame.minY + 2,
                             width: 1, height: 17)
    let adapter = AccessibilityTextAdapter()
    let rects = adapter.layoutRects(
        attributedText: attributed, range: range, elementFrame: frame,
        caret: attributed.length, actualCaret: actualCaret)
    check(rects.count == 1, "measures one committed Gmail line")
    if let rect = rects.first {
        let expectedX = frame.minX + padding + NSAttributedString(
            string: "The expected cost of ", attributes: [.font: font]).size().width
        check(abs(rect.minX - expectedX) < 1.5, "calibrates the range to Chrome's live caret")
        check(abs(rect.width - NSAttributedString(string: "supplies", attributes: [.font: font]).size().width) < 1.5,
              "keeps the accepted phrase width")
        check(abs(rect.height - actualCaret.height) < 0.01,
              "uses Chrome's measured caret height instead of a loose line box")
    }
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
}

print("reference store")
do {
    let url = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("lasso-refs-\(UUID().uuidString).json")
    let store = DependencyReferenceStore(url: url)
    let reference = DependencyReference(
        id: "ref_1", objectId: "obj_1", versionId: "v1",
        hostBundleIdentifier: "com.google.Chrome", hostApplication: "Google Chrome",
        documentContext: "compose-1",
        anchor: TextAnchor(text: "office supplies", prefixContext: "cost of ",
                           suffixContext: " is", approximateOffset: 22),
        state: .healthy, label: "Office Supplies", valueText: "400",
        sourcePath: "Income-Statement.xlsx", sourceLocation: "Accounting!B21",
        sourceColorSlot: 2,
        createdAt: Date(), updatedAt: Date())

    store.add(reference)
    check(store.references.count == 1, "stores a reference")
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

    store.update(id: "ref_1") { $0.state = .changed }
    check(store.reference(id: "ref_1")?.state == .changed, "records a state change")

    store.remove(id: "ref_1")
    check(store.references.isEmpty, "removes on unlink")
    check(DependencyReferenceStore(url: url).references.isEmpty, "removal persists")
    try? FileManager.default.removeItem(at: url)
}

print("claim-aware suggestion semantics")
do {
    check(AssistSuggestionSemantics.insertionText(
        claimType: "ENTITY", label: "Bad Debts/Losses and Thefts", value: "25") ==
          "Bad Debts/Losses and Thefts",
          "an entity claim inserts the indexed row name instead of a child cell value")
    check(AssistSuggestionSemantics.insertionText(
        claimType: "QUANTITATIVE", label: "Bad Debts/Losses and Thefts · Current Period", value: "25") == "25",
          "a quantitative claim still inserts the source-backed value")
}

print("")
print(failures == 0 ? "\(checks) checks passed" : "\(failures) of \(checks) checks FAILED")
exit(failures == 0 ? 0 : 1)

