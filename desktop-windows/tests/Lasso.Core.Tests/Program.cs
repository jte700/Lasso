//  Pure-logic tests for dependency anchoring and geometry.
//  Run by build.ps1 — no framework, no dependencies.
//
//  A direct port of desktop/tests/main.swift. The check names are deliberately
//  identical so a behavioural difference between the macOS and Windows
//  companions shows up as the same sentence failing on one of them.

using System.Text.Json;
using Lasso.Core;

var failures = 0;
var checks = 0;

void Check(bool condition, string what)
{
    checks++;
    if (condition)
    {
        Console.WriteLine($"  ok   {what}");
    }
    else
    {
        failures++;
        Console.WriteLine($"  FAIL {what}");
    }
}

TextAnchor Anchor(string phrase, string document)
{
    var start = TextAnchorResolver.Indices(phrase, document)[0];
    return TextAnchor.Make(document, new UnitRange(start, start + phrase.Length))!;
}

UnitRange? ResolvedRange(TextAnchor anchor, string document)
{
    var resolution = TextAnchorResolver.Resolve(anchor, document);
    return resolution.IsResolved ? resolution.Range : null;
}

string? Text(string document, UnitRange? range) =>
    range is { } found ? document.Substring(found.Start, found.Count) : null;


// ── Stage A: completion insertion ──────────────────────────────────────────
// Regression cover for the destructive bug: accepting a suggestion deleted the
// whole sentence, because the replacement length came from a server-supplied
// claim range with no relation to what was being inserted.

/// Runs the whole transaction against a simulated host and returns the result.
(string After, UnitRange? Range, CompletionFailure? Failure) Accept(
    string before, string insert, int? caret = null)
{
    var position = caret ?? before.Length;
    var planned = CompletionTransaction.Plan(before, position, insert);
    if (!planned.IsSuccess) return (before, null, CompletionFailure.RangeOutOfBounds);
    var plan = planned.Value;
    if (CompletionTransaction.Validate(plan, before) is { } invalid) return (before, null, invalid);
    var after = CompletionTransaction.Apply(plan, before);
    var verified = CompletionTransaction.Verify(before, after, plan);
    return verified.IsSuccess ? (after, verified.Value, null) : (after, null, verified.Failure);
}


Console.WriteLine("email hyperlink formats");
{
    var url = new Uri("https://example.test/d/source?a=1&b=2");
    var html = ShareFormats.Html("Supplies & <cost>", url);
    Check(html.Contains("Supplies &amp; &lt;cost&gt;"), "escapes source labels in rich email");
    Check(html.Contains("href=\"https://example.test/d/source?a=1&amp;b=2\""),
          "preserves the hyperlink destination");
    Check(ShareFormats.PlainText("Supplies & <cost>", url).Contains(url.AbsoluteUri),
          "plain-text email fallback keeps the URL");
    var rtf = ShareFormats.Rtf("Supplies & <cost>", url);
    Check(rtf.Contains("Supplies & <cost>"), "native rich-text paste preserves the label");
    Check(rtf.Contains("HYPERLINK \"https://example.test/d/source?a=1&b=2\""),
          "native rich-text paste retains a clickable link");
    // CF_HTML is what Windows hosts actually read; its header must describe the
    // fragment it carries or the paste arrives empty.
    var fragment = ShareFormats.HtmlClipboardFragment(html);
    Check(fragment.Contains("StartFragment:") && fragment.Contains("<!--StartFragment-->") && fragment.Contains(html),
          "wraps rich email in a CF_HTML fragment Windows hosts accept");
}

Console.WriteLine("canonical source identity");
{
    var workbook = AssistSourceIdentity.CanonicalPath(
        candidatePath: "Income-Statement-Template.xls",
        provenanceLabel: "Accounting · Supplies · Current Period");
    Check(workbook == "Income-Statement-Template.xls",
          "uses the owning file instead of a row or column breadcrumb");
    Check(AssistSourceIdentity.Key("Folder/../Income-Statement-Template.xls", "cell")
          == AssistSourceIdentity.Key("Income-Statement-Template.xls", "row"),
          "groups different indexed objects from the same normalized file");
    Check(AssistSourceIdentity.Key("Folder\\Income-Statement-Template.xls", "windows")
          == AssistSourceIdentity.Key("Folder/Income-Statement-Template.xls", "posix"),
          "normalizes source separators across metadata producers");
    Check(AssistSourceIdentity.Key("Paper.pdf", "a") != AssistSourceIdentity.Key("Workbook.xlsx", "b"),
          "keeps different source documents distinct");
    var colors = AssistSourceIdentity.ColorAssignments(
        [("workbook", 0), ("workbook", 1), ("paper", 0)],
        paletteCount: 8,
        fallback: _ => 0);
    Check(colors["workbook"] == 0 && colors["paper"] == 1,
          "repairs legacy same-source colors and avoids cross-source collisions");
}

Console.WriteLine("local source files");
{
    const string root = @"C:\Lasso Source Project";
    var workbook = Path.Combine(root, "Accounting", "Income Statement.xlsx");
    bool Exists(string path) => path == workbook;

    Check(AssistSourceIdentity.LocalFilePath(root, "Accounting/Income Statement.xlsx", Exists) == workbook,
          "resolves a project-relative indexed file");
    Check(AssistSourceIdentity.LocalFilePath(root, @"Accounting\Income Statement.xlsx", Exists) == workbook,
          "normalizes source separators before opening");
    Check(AssistSourceIdentity.LocalFilePath(root, workbook, Exists) == workbook,
          "accepts an absolute source inside the project");
    Check(AssistSourceIdentity.LocalFilePath(root, "../outside.xlsx", _ => true) is null,
          "rejects a relative path that escapes the project");
    Check(AssistSourceIdentity.LocalFilePath(root, @"C:\outside.xlsx", _ => true) is null,
          "rejects an absolute path outside the project");
    Check(AssistSourceIdentity.LocalFilePath(root, "missing.xlsx", _ => false) is null,
          "does not ask Windows to open a missing file");
    // Windows paths are case-insensitive, so a differently-cased root is the
    // same folder and must not read as an escape attempt.
    Check(AssistSourceIdentity.LocalFilePath(@"c:\lasso source project",
              "Accounting/Income Statement.xlsx",
              path => string.Equals(path, workbook, StringComparison.OrdinalIgnoreCase)) is not null,
          "treats a differently-cased project root as the same folder");
}

Console.WriteLine("completion insertion preserves the sentence");
{
    var one = Accept("The expected cost of office sup", "office supplies");
    Check(one.After == "The expected cost of office supplies", "completes a partial phrase");
    Check(Text(one.After, one.Range) == "office supplies", "reports the exact inserted range");

    // Caret in the middle of a sentence: the tail must survive.
    var two = Accept("I reviewed the quarterly office sup yesterday.", "office supplies", caret: 35);
    Check(two.After == "I reviewed the quarterly office supplies yesterday.",
          "leaves the rest of the sentence untouched");

    var three = Accept("The value is 61", "612");
    Check(three.After == "The value is 612", "extends a partial number");

    var four = Accept("Revenue is $4.", "$4.2M");
    Check(four.After == "Revenue is $4.2M", "keeps the words before a value");
    Check(four.After.StartsWith("Revenue is "), "preserves the sentence opening");

    var five = Accept("the cost is ", "400");
    Check(five.After == "the cost is 400", "inserts when nothing was typed towards it");
}

Console.WriteLine("a completion can never delete more than it inserts");
{
    // The exact shape of the bug: a claim covering the whole sentence.
    const string sentence = "The expected cost of office sup";
    var planned = CompletionTransaction.Plan(sentence, sentence.Length, "Office Supplies");
    if (!planned.IsSuccess)
    {
        Check(false, "plans an edit");
        return 1;
    }
    var plan = planned.Value;
    Check(plan.Range.Count <= "Office Supplies".Length, "replacement is bounded by the inserted text");
    Check(plan.Range.Count == 10, "rewrites only \"office sup\"");
    Check(plan.ExpectedPrefix == "office sup", "knows exactly what it is replacing");

    var after = CompletionTransaction.Apply(plan, sentence);
    Check(after == "The expected cost of Office Supplies", "sentence survives");
    Check(after.Contains("The expected cost of"), "opening words are intact");
}

Console.WriteLine("stale and invalid plans are refused");
{
    const string document = "The expected cost of office sup";
    var planned = CompletionTransaction.Plan(document, document.Length, "office supplies");
    if (!planned.IsSuccess)
    {
        Check(false, "plans an edit");
        return 1;
    }
    var plan = planned.Value;
    // The user kept typing after the suggestion was produced.
    const string moved = "The expected cost of office supper dish";
    Check(CompletionTransaction.Validate(plan, moved, moved.Length) == CompletionFailure.PrefixMismatch,
          "refuses a plan whose text has moved on");
    Check(CompletionTransaction.Validate(plan, "The expected cost of office sup", 31) is null,
          "accepts a plan that is still current");

    // A range beyond the document is refused rather than clamped.
    Check(CompletionTransaction.Validate(plan, "short") == CompletionFailure.RangeOutOfBounds,
          "refuses a range outside the document");

    var impossible = CompletionTransaction.Plan(document, 999, "x");
    Check(!impossible.IsSuccess && impossible.Failure == CompletionFailure.RangeOutOfBounds,
          "refuses an impossible caret");
}

Console.WriteLine("verification catches a host that edits elsewhere");
{
    const string before = "The expected cost of office sup";
    var planned = CompletionTransaction.Plan(before, before.Length, "office supplies");
    if (!planned.IsSuccess)
    {
        Check(false, "plans an edit");
        return 1;
    }
    var plan = planned.Value;
    var correct = CompletionTransaction.Apply(plan, before);
    var clean = CompletionTransaction.Verify(before, correct, plan);
    Check(clean.IsSuccess && clean.Value == new UnitRange(21, 36), "accepts a clean edit");

    // The host also dropped an unrelated word.
    var damaged = CompletionTransaction.Verify(before, "expected cost of office supplies", plan);
    Check(!damaged.IsSuccess && damaged.Failure == CompletionFailure.OutsideRangeModified,
          "rejects an edit that changed other text");

    // The host did nothing at all.
    var nothing = CompletionTransaction.Verify(before, before, plan);
    Check(!nothing.IsSuccess && nothing.Failure is CompletionFailure.InsertionMissing
              or CompletionFailure.OutsideRangeModified,
          "rejects an edit that never happened");
}

Console.WriteLine("moving browser windows verify an accepted dependency");
{
    var lead = new string('x', 1_300);
    var fullBefore = lead + "The expected cost of office sup";
    var beforeStart = fullBefore.Length - 1_200;
    var beforeWindow = fullBefore[beforeStart..];
    var planned = CompletionTransaction.Plan(beforeWindow, beforeWindow.Length, "office supplies");
    if (!planned.IsSuccess)
    {
        Check(false, "plans inside a browser window");
        return 1;
    }
    var plan = planned.Value;
    var absoluteStart = beforeStart + plan.Range.Start;
    var fullAfter = string.Concat(
        fullBefore.AsSpan(0, beforeStart + plan.Range.Start),
        plan.InsertText.AsSpan(),
        fullBefore.AsSpan(beforeStart + plan.Range.End));
    var afterStart = fullAfter.Length - 1_200;
    var afterWindow = fullAfter[afterStart..];
    var result = CompletionTransaction.Verify(
        new CompletionSnapshot(beforeStart, beforeWindow),
        new CompletionSnapshot(afterStart, afterWindow), plan);

    if (result.IsSuccess)
    {
        var verified = result.Value;
        Check(verified.DocumentRange == new UnitRange(absoluteStart, absoluteStart + plan.InsertText.Length),
              "returns the absolute Gmail document range");
        Check(afterWindow.Substring(verified.SnapshotRange.Start, verified.SnapshotRange.Count) == "office supplies",
              "returns the phrase inside the shifted window");
        var anchor = TextAnchor.Make(afterWindow, verified.SnapshotRange, documentOffset: afterStart);
        Check(anchor?.ApproximateOffset == absoluteStart, "anchors with the absolute browser offset");
    }
    else
    {
        Check(false, "verifies a completion after the 1,200-character window shifts");
    }
}

Console.WriteLine("web editors normalize spaces without losing dependencies");
{
    const string beforeText = "The supplies increased by\u00A0";
    var planned = CompletionTransaction.Plan(beforeText, beforeText.Length, "400");
    if (!planned.IsSuccess)
    {
        Check(false, "plans a value after a web-editor space");
        return 1;
    }
    var plan = planned.Value;
    const string after = "The supplies increased by 400";
    var normalized = CompletionTransaction.Verify(
        new CompletionSnapshot(0, beforeText), new CompletionSnapshot(0, after), plan);
    if (normalized.IsSuccess)
    {
        var verified = normalized.Value;
        Check(verified.DocumentRange == new UnitRange(beforeText.Length, beforeText.Length + 3),
              "accepts Gmail changing a trailing NBSP to a visible space");
        Check(after.Substring(verified.SnapshotRange.Start, verified.SnapshotRange.Count) == "400",
              "anchors the second accepted dependency");
    }
    else
    {
        Check(false, "accepts equivalent web-space normalization");
    }

    var rejected = CompletionTransaction.Verify(
        new CompletionSnapshot(0, beforeText),
        new CompletionSnapshot(0, "The supplies increased on 400"), plan);
    Check(!rejected.IsSuccess && rejected.Failure == CompletionFailure.OutsideRangeModified,
          "still rejects an actual surrounding-text change");

    Check(!CompletionTransaction.InsertionIsAtCaret("40", "An earlier value was 400"),
          "does not mistake an older overlapping value for a new insertion");
    Check(CompletionTransaction.InsertionIsAtCaret("40", "An earlier value was 400, now 40"),
          "recognizes the value only when it ends at the caret");

    var alreadyTyped = Accept("The prior-period value was 310", "310");
    Check(alreadyTyped.After == "The prior-period value was 310",
          "accepting a fully typed overlay value preserves its text");
    Check(Text(alreadyTyped.After, alreadyTyped.Range) == "310",
          "a fully typed overlay value still receives a dependency range");
}

Console.WriteLine("the verified range is what the dependency anchors to");
{
    const string before = "The expected cost of office sup";
    var planned = CompletionTransaction.Plan(before, before.Length, "office supplies");
    if (!planned.IsSuccess)
    {
        Check(false, "produces a verified range");
        return 1;
    }
    var plan = planned.Value;
    var after = CompletionTransaction.Apply(plan, before);
    var verified = CompletionTransaction.Verify(before, after, plan);
    if (!verified.IsSuccess)
    {
        Check(false, "produces a verified range");
        return 1;
    }
    // Stage B starts from that exact range, never from a fresh text search.
    var anchor = TextAnchor.Make(after, verified.Value)!;
    Check(anchor.Text == "office supplies", "anchors to exactly the accepted phrase");
    Check(anchor.Text != "The expected cost of office supplies", "does not swallow the sentence");
    Check(anchor.Text != "supplies", "does not anchor to a fragment");
    Check(anchor.PrefixContext.EndsWith("cost of "), "records the text before it");
}

Console.WriteLine("anchor creation");
{
    const string document = "The expected cost of office supplies is $400.";
    var made = Anchor("office supplies", document);
    Check(made.Text == "office supplies", "captures the phrase");
    Check(made.PrefixContext.EndsWith("expected cost of "), "captures preceding context");
    Check(made.SuffixContext.StartsWith(" is $400"), "captures following context");
    Check(made.ApproximateOffset == 21, "records where it started");
}

Console.WriteLine("relocation after editing");
{
    const string original = "The expected cost of office supplies is $400.";
    var made = Anchor("office supplies", original);

    const string inserted = "In Q3, the expected cost of office supplies is $400.";
    Check(Text(inserted, ResolvedRange(made, inserted)) == "office supplies",
          "survives text inserted before it");

    const string deleted = "Cost of office supplies is $400.";
    Check(Text(deleted, ResolvedRange(made, deleted)) == "office supplies",
          "survives text deleted before it");

    const string after = "The expected cost of office supplies is $438 this quarter.";
    Check(Text(after, ResolvedRange(made, after)) == "office supplies",
          "survives text changed after it");

    Check(ResolvedRange(made, "Nothing relevant here.") is null, "does not invent a location");
    var missing = TextAnchorResolver.Resolve(made, "Nothing relevant here.");
    Check(missing.Failure == AnchorFailure.TextMissing, "reports the phrase as missing");
}

Console.WriteLine("duplicate phrases");
{
    const string document = "Office supplies were higher. We should review office supplies tomorrow.";
    var second = TextAnchorResolver.Indices("office supplies", document)[0];
    var made = TextAnchor.Make(document, new UnitRange(second, second + 15))!;

    Check(ResolvedRange(made, document)?.Start == second,
          "picks the occurrence that was linked, not the first match");

    // Both occurrences keep their context: the linked one is still identifiable.
    const string edited = "Office supplies were higher this year. We should review office supplies tomorrow.";
    var expected = TextAnchorResolver.Indices("office supplies", edited)[0];
    Check(ResolvedRange(made, edited)?.Start == expected,
          "stays on the linked occurrence after editing elsewhere");
}

Console.WriteLine("ambiguity is refused");
{
    // A repeating passage: several occurrences have identical context on both
    // sides, so nothing distinguishes them but position.
    const string block = "the cost of office supplies is fine. ";
    var document = string.Concat(Enumerable.Repeat(block, 5));
    var middle = TextAnchorResolver.Indices("office supplies", document)[2];
    var made = TextAnchor.Make(document, new UnitRange(middle, middle + 15))!;

    Check(ResolvedRange(made, document)?.Start == middle,
          "position still identifies the linked occurrence");

    // Now place the remembered offset far from every candidate: position can no
    // longer decide, and the reference must refuse rather than guess.
    var adrift = made with { ApproximateOffset = 10_000 };
    var resolution = TextAnchorResolver.Resolve(adrift, document);
    Check(resolution.Failure == AnchorFailure.Ambiguous,
          "refuses to guess between identical candidates");
}

Console.WriteLine("geometry");
{
    // Windows has one origin: UI Automation bounding rectangles, Win32 screen
    // coordinates, and WPF window coordinates all start at the top-left. The
    // macOS build's vertical flip must therefore NOT exist here — porting it
    // would offset every highlight by the height of the display.
    var reported = new HostRect(100, 200, 120, 18);
    var overlay = new HostRect(90, 188, 160, 40);
    var local = HostGeometryConverter.ToOverlayLocal(reported, overlay);
    Check(local.X == 10 && local.Y == 12, "moves screen geometry into the overlay window");
    Check(local.Width == reported.Width && local.Height == reported.Height,
          "keeps dependency highlight dimensions in overlay space");
    Check(HostGeometryConverter.ToOverlayLocal(reported, new HostRect(0, 0, 0, 0)) == reported,
          "applies no vertical flip: screen and overlay share the top-left origin");

    Check(HostGeometryConverter.IsUsable(reported), "accepts a measured line rectangle");
    Check(!HostGeometryConverter.IsUsable(new HostRect(0, 0, 120, 0)), "rejects an empty rectangle");
    Check(!HostGeometryConverter.IsUsable(new HostRect(0, 0, 120, 900)),
          "rejects a whole-pane rectangle a host returned instead of a line");
    Check(!HostGeometryConverter.IsUsable(new HostRect(double.NaN, 0, 120, 18)),
          "rejects non-finite geometry");
}

Console.WriteLine("browser editor text-run offsets");
{
    const string phrase = "I was looking at the supplies";
    foreach (var suffix in new[] { "", "\n", "\n\n", "\r\n\r\n" })
    {
        var ranges = TextRunAligner.ElementRanges([phrase], phrase + suffix);
        Check(ranges is not null && ranges.SequenceEqual([new UnitRange(0, phrase.Length)]),
              "trailing empty paragraphs do not change the word's offsets");
    }
    Check(TextRunAligner.ElementRanges(["First", "supplies", "Next"], "First\n\nsupplies\nNext")
              is { } paragraphs
          && paragraphs.SequenceEqual([new UnitRange(0, 5), new UnitRange(7, 15), new UnitRange(16, 20)]),
          "maps browser-generated paragraph separators");
    Check(TextRunAligner.ElementRanges(["office\nsupplies"], "office\nsupplies") is { } literal
          && literal.SequenceEqual([new UnitRange(0, 15)]),
          "preserves a literal newline inside a text leaf");
    Check(TextRunAligner.ElementRanges(["📦 ", "sup", "plies"], "📦 supplies") is { } emoji
          && emoji.SequenceEqual([new UnitRange(0, 3), new UnitRange(3, 6), new UnitRange(6, 11)]),
          "preserves UTF-16 offsets across emoji and rich text runs");
    Check(TextRunAligner.ElementRanges(["supplies", "supplies"], "supplies\nsupplies") is { } repeated
          && repeated.SequenceEqual([new UnitRange(0, 8), new UnitRange(9, 17)]),
          "keeps repeated words in their original document order");
    Check(TextRunAligner.ElementRanges(["supplies"], "unrelated supplies") is null,
          "does not search ahead to an unrelated occurrence");
    Check(TextRunAligner.ElementRanges(["supplies"], "supplies changed") is null,
          "rejects a stale or incomplete accessibility subtree");
    Check(TextRunAligner.ElementRanges(["First", "supplies"], "First other supplies") is null,
          "does not skip missing visible text between runs");
}

Console.WriteLine("multi-line fragments");
{
    // A wrapped phrase is several rectangles that must group into one hit target.
    var hit = new DependencyGeometry("ref_1", [
        new HostRect(10, 100, 200, 18),
        new HostRect(10, 122, 90, 18),
    ]);
    Check(hit.Fragments.Count == 2, "keeps one rectangle per line");
    Check(hit.Contains(50, 108), "hits the first line");
    Check(hit.Contains(50, 130), "hits the second line");
    Check(!hit.Contains(400, 108), "misses outside every fragment");
    Check(hit.Bounds.Height >= 40, "bounds span both lines");

    // Per-run rectangles on one line collapse into a single underline.
    var coalesced = DependencyGeometry.Coalesce([
        new HostRect(10, 100, 40, 18),
        new HostRect(50, 101, 60, 18),
        new HostRect(10, 122, 90, 18),
    ], "ref_2");
    Check(coalesced.Fragments.Count == 2, "merges character runs that share a line");
    Check(coalesced.Fragments[0].Width >= 100, "the merged line spans both runs");
}

Console.WriteLine("reference store");
{
    var path = Path.Combine(Path.GetTempPath(), $"lasso-refs-{Guid.NewGuid()}.json");
    var store = new DependencyReferenceStore(path);
    var reference = new DependencyReference
    {
        Id = "ref_1", ObjectId = "obj_1", VersionId = "v1",
        HostBundleIdentifier = "chrome.exe", HostApplication = "Google Chrome",
        DocumentContext = "compose-1",
        Anchor = new TextAnchor
        {
            Text = "office supplies", PrefixContext = "cost of ",
            SuffixContext = " is", ApproximateOffset = 22,
        },
        State = DependencyVisualState.Healthy, Label = "Office Supplies", ValueText = "400",
        SourcePath = "Income-Statement.xlsx", SourceLocation = "Accounting!B21",
        SourceColorSlot = 2,
        CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow,
    };

    store.Add(reference);
    Check(store.References.Count == 1, "stores a reference");
    Check(store.ReferencesFor("compose-1", "chrome.exe").Count == 1, "finds it by host document");
    Check(store.ReferencesFor("compose-2", "chrome.exe").Count == 0, "never leaks into another document");
    Check(store.ReferencesFor("compose-1", "msedge.exe").Count == 0, "never leaks into another application");

    var reloaded = new DependencyReferenceStore(path);
    Check(reloaded.References.Count == 1, "survives a restart");
    Check(reloaded.Reference("ref_1")?.SourceColorSlot == 2, "persists the source color identity");

    store.Update("ref_1", existing => existing.State = DependencyVisualState.Changed);
    Check(store.Reference("ref_1")?.State == DependencyVisualState.Changed, "records a state change");

    store.Remove("ref_1");
    Check(store.References.Count == 0, "removes on unlink");
    Check(new DependencyReferenceStore(path).References.Count == 0, "removal persists");
    try { File.Delete(path); } catch (IOException) { /* best effort */ }
}

Console.WriteLine("claim-aware suggestion semantics");
{
    Check(AssistSuggestionSemantics.InsertionText("ENTITY", "Bad Debts/Losses and Thefts", "25")
              == "Bad Debts/Losses and Thefts",
          "an entity claim inserts the indexed row name instead of a child cell value");
    Check(AssistSuggestionSemantics.InsertionText(
              "QUANTITATIVE", "Bad Debts/Losses and Thefts · Current Period", "25") == "25",
          "a quantitative claim still inserts the source-backed value");
}

Console.WriteLine("sentence casing follows the host sentence");
{
    Check(AssistCasing.MatchCasing("Office Supplies", "office sup", "The expected cost of office sup", 31)
              == "office supplies",
          "lowers a title-cased label dropped mid-sentence");
    Check(AssistCasing.MatchCasing("Office Supplies", "office sup", "Reviewed. office sup", 20)
              == "office supplies",
          "agrees with the word being typed, not the sentence before it");
    // The guard is reached when what precedes the caret ends in sentence
    // punctuation, as an abbreviation does.
    Check(AssistCasing.MatchCasing("Office Supplies", "e.g.", "The usual items, e.g.", 21)
              == "Office Supplies",
          "keeps the capital when the caret follows sentence punctuation");
    Check(AssistCasing.MatchCasing("IFRS Revenue", "ifrs", "reported under ifrs", 19) == "IFRS revenue",
          "leaves an acronym alone while lowering a plain title-cased word");
    Check(AssistCasing.MatchCasing("Office Supplies", "Office Sup", "The cost of Office Sup", 22)
              == "Office Supplies",
          "respects what the writer actually typed");
    Check(AssistCasing.TrailingWord("The expected cost of office sup") == "sup",
          "casing looks only at the run before the caret");
}

Console.WriteLine("prediction responses become insertable rows");
{
    var payload = """
    {"prediction":{
      "workspaceHeading":"Values For Office Supplies",
      "claims":[{"start":21,"end":31,"type":"QUANTITATIVE","candidates":[
        {"id":"obj_1","versionId":"v1","snapshotId":"s1","label":"Office Supplies",
         "valueText":"400","path":"Accounting/Income-Statement.xlsx",
         "anchor":{"sheet":"Accounting","rowIndex":21,"columnIndex":1},
         "ranking":{"reason":"used recently"}}]}]}}
    """;
    var data = System.Text.Encoding.UTF8.GetBytes(payload);
    var rows = PredictionParser.Parse(data, windowLength: 31, projectId: "accounting");
    Check(rows.Count == 1 && rows[0].InsertText == "400", "a quantitative claim offers its value");
    Check(rows[0].Location == "Accounting!B21", "formats the exact matched cell");
    Check(rows[0].ReplaceFrom == 21, "rewrites the claim only when it runs to the caret");
    Check(rows[0].IsShareable && rows[0].ObjectId == "obj_1", "carries the indexed object identity");
    Check(PredictionParser.Heading(data) == "values for office supplies", "reports the workspace heading");

    // A claim that stops short of the caret is a plain insertion, not a rewrite.
    var shorter = PredictionParser.Parse(data, windowLength: 40, projectId: "accounting");
    Check(shorter[0].ReplaceFrom is null, "does not rewrite a claim the caret has moved past");

    Check(PredictionParser.Parse(System.Text.Encoding.UTF8.GetBytes("not json"), 0, "p").Count == 0,
          "an unreadable response offers nothing rather than throwing");
    Check(PredictionParser.SpreadsheetColumn(0) == "A" && PredictionParser.SpreadsheetColumn(26) == "AA",
          "spreadsheet columns carry past Z");
}

Console.WriteLine("source-backed model previews");
{
    const string bounds = """{"minX":10.0,"minY":20.0,"maxX":20.0,"maxY":30.0}""";
    var modelJson = $$"""
    {"kind":"model-plan","bounds":{{bounds}},"focusBounds":{{bounds}},
     "selected":{"id":42,"guid":"wall-guid","label":"Exterior Wall","entityType":"IFCWALLSTANDARDCASE"},
     "storey":{"label":"Level 1"},"warnings":[],
     "elements":[{"id":42,"guid":"wall-guid","label":"Exterior Wall","entityType":"IFCWALLSTANDARDCASE",
       "role":"context","selected":true,
       "polygons":[[[10.0,20.0],[20.0,20.0],[20.0,30.0],[10.0,30.0]],
                   [[12.0,22.0],[18.0,22.0],[18.0,28.0],[12.0,28.0]]]}]}
    """;
    string Response(string preview) => $$"""
    {"source":{"filename":"Building.ifc","location":"Exterior Wall","objectType":"DRAWING_ANNOTATION"},
     "path":"Architecture/Building.ifc","preview":{{preview}}}
    """;

    var parsed = AssistDocumentPreview.Parse(System.Text.Encoding.UTF8.GetBytes(Response(modelJson)))!;
    var model = parsed.Model!;
    Check(model.SelectedEntityType == "IFCWALLSTANDARDCASE" && model.Elements[0].Selected,
          "selects non-room IFC products by source identity");
    Check(model.Elements[0].Guid == "wall-guid" && model.Elements[0].Polygons.Count == 2,
          "preserves selected geometry and opening rings from the source response");
    Check(parsed.Path == "Architecture/Building.ifc" && parsed.Rows.Count == 0,
          "routes an IFC preview to model rendering instead of an empty table");

    var transform = AssistModelTransform.Create(model.FocusBounds, new HostRect(5, 7, 220, 120))!;
    Check(transform.Scale == 10, "fits focused geometry without changing its aspect ratio");
    Check(transform.Point(new HostPoint(10, 30)) == new HostPoint(65, 17)
          && transform.Point(new HostPoint(20, 20)) == new HostPoint(165, 117),
          "keeps IFC plan orientation when mapping into the preview viewport");
    Check(transform.Contains(model.Elements[0], transform.Point(new HostPoint(11, 21)))
          && !transform.Contains(model.Elements[0], transform.Point(new HostPoint(15, 25))),
          "renders real wall geometry while leaving its opening unfilled");
    Check(AssistModelTransform.Create(model.Bounds, HostRect.Empty) is null,
          "rejects an empty drawing viewport");

    using (var degenerate = JsonDocument.Parse("""{"minX":0,"minY":0,"maxX":0,"maxY":2}"""))
    using (var infinite = JsonDocument.Parse("""{"minX":0,"minY":0,"maxX":1e999,"maxY":2}"""))
    {
        Check(AssistModelBounds.Parse(degenerate.RootElement) is null
              && AssistModelBounds.Parse(infinite.RootElement) is null,
              "rejects degenerate and non-finite geometry bounds");
    }

    using (var invalid = JsonDocument.Parse("""
        {"kind":"model-plan","bounds":{"minX":10,"minY":20,"maxX":20,"maxY":30},
         "elements":[{"polygons":[[[1e999,1],[2,3],[4,5]]]}]}
        """))
    {
        Check(AssistModelPreview.Parse(invalid.RootElement) is null,
              "does not draw fabricated replacement geometry for malformed coordinates");
    }

    var unavailable = AssistDocumentPreview.Parse(System.Text.Encoding.UTF8.GetBytes(Response(
        """{"kind":"model-unavailable","reason":"This element has properties but no geometric representation."}""")))!;
    Check(unavailable.Model is null
          && unavailable.UnavailableReason?.Contains("no geometric representation") == true,
          "explains why an indexed element cannot be drawn");

    var table = AssistDocumentPreview.Parse(System.Text.Encoding.UTF8.GetBytes(Response(
        """{"columns":["B"],"headers":["Area"],"rows":[{"rowNumber":7,"cells":[{"value":"42","cited":true}]}]}""")))!;
    Check(table.Model is null && table.Rows[0].Cells[0].Cited && table.Rows[0].RowNumber == 7,
          "preserves exact-cell spreadsheet preview parsing");
}

Console.WriteLine("");
Console.WriteLine(failures == 0 ? $"{checks} checks passed" : $"{failures} of {checks} checks FAILED");
return failures == 0 ? 0 : 1;
