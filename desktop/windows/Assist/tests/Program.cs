using System.Text.Json;
using Lasso.Windows.Assist;
int checks = 0;
void Check(bool condition, string message) { checks++; if (!condition) throw new Exception(message); }
Check(CompletionPlan.Create("Office Sup", "Supplies")?.Suffix == "plies", "Completion retains typed word prefix");
Check(CompletionPlan.Create("data", "amount")?.Suffix == "amount", "Unrelated word endings must not be treated as a completion prefix");
Check(CompletionPlan.Create("value ", " cost")?.Suffix == "cost", "Whitespace overlap is preserved");
var exact = CompletionPlan.Create("400", "400");
Check(exact?.Suffix == "" && exact.CompletedPhrase == "400", "Exact matches remain selectable for source linking without typing twice");
Check(exact!.Verify("400", "", ""), "An unchanged exact match can be verified");
Check(!exact.Verify("", "", ""), "Empty browser readback cannot verify an exact match");
Check(CompletionPlan.Create("s", "sentence", true)?.Suffix == "sentence", "Sentence continuation is appended literally");
Check(CompletionPlan.Create("", "hello\nworld") == null, "No action keys in external insertion");
Check(CompletionPlan.Create("", "\ud800") == null, "Reject malformed UTF16");
Check(CompletionPlan.Create("", "🌱")?.Suffix == "🌱", "Preserve surrogate pair input");
var plan = CompletionPlan.Create("Total: 4", "400")!;
Check(plan.Verify("Total: 400", ".", "."), "Confirm exact inserted suffix with unchanged following text");
Check(!plan.Verify("Total: 400", ".", "!"), "Changed following text invalidates provenance");
Check(!plan.Verify("Total: 401", ".", "."), "Readback mismatch creates no reference");
using var payload = JsonDocument.Parse("""{"prediction":{"workspaceCompletions":[{"replacementText":"400","dependencyCandidate":{"id":"o1","versionId":"v1","snapshotId":"s1","path":"Finance/Costs.csv","label":"Supplies","valueText":"400"}}]}}""");
var result = AssistPayload.ParsePrediction(payload.RootElement, "project");
Check(result.Suggestions.Count == 1, "Parse actual API completion shape");
Check(result.Suggestions[0].ObjectId == "o1" && result.Suggestions[0].VersionId == "v1", "Pin exact evidence identity");
var replace = CompletionPlan.Create("I saw revenue", "Sales revenue", false, 6, 13)!;
Check(replace.RemoveLength == 7 && replace.ExpectedBeforeCaret == "I saw Sales revenue", "Replace only the claimed word when selecting a different candidate");
Check(replace.Verify("I saw Sales revenue", ".", "."), "Replacement readback verifies untouched surrounding text");
Check(!replace.Verify("I lost Sales revenue", ".", "."), "Outside replacement edits invalidate the source reference");
Check(CompletionPlan.Create("I saw revenue", "Revenue", false, 6, 12) == null, "Reject a claim at a stale caret");
var anchor = TextAnchor.AtCaret("I saw revenue", ".", "revenue");
Check(anchor.Locate("I saw revenue.") == 6, "Accepted word is located by its surrounding context");
Check(anchor.Locate("Earlier revenue. I saw revenue.") == 23, "Earlier occurrences cannot capture the link");
Check(anchor.Locate("I saw profits.") == -1, "Edited text loses the link");
Check(anchor.Locate("I saw revenue. I saw revenue.") == -1, "Ambiguous occurrences never open arbitrary evidence");
var atStart = TextAnchor.AtCaret("Revenue", "", "Revenue");
Check(atStart.Locate("Revenue grew") == 0, "Typing after an accepted word keeps its link");
using var variablePayload = JsonDocument.Parse(JsonSerializer.Serialize(new { prediction = new { claims = new[] { new {
    type = "STUDY_VARIABLE", start = 21, end = 28, candidates = Enumerable.Range(1, 5).Select(i => new {
        id = "o" + i, versionId = "v" + i, snapshotId = "s1", label = i == 1 ? "Revenue" : "Revenue " + i,
        valueText = "revenue; inferred numeric variable; observed range 5 to 69; examples 41, 5, 42",
        path = "income-statement.xlsx" }) } } } }));
var variables = AssistPayload.ParsePrediction(variablePayload.RootElement, "project").Suggestions;
Check(variables.Count == 5, "Keep all five server suggestions");
Check(variables[0].InsertText == "Revenue", "Tab inserts the variable name, never inference diagnostics");
Check(variables.All(s => s.ReplaceStart == 21 && s.ReplaceEnd == 28), "Carry the engine's claim boundaries");
Check(variables.All(s => CompletionPlan.Create("I was looking at the revenue", s.InsertText, s.IsContinuation, s.ReplaceStart, s.ReplaceEnd) != null), "Exact matches and alternatives both remain selectable");
var html = SharedLinkFormats.HtmlClipboard("R&D 🌱", "https://example.test/d/abc?a=1&b=2");
var bytes = System.Text.Encoding.UTF8.GetBytes(html);
int Offset(string name) => int.Parse(System.Text.RegularExpressions.Regex.Match(html, name + @":(\d+)").Groups[1].Value);
var fragment = System.Text.Encoding.UTF8.GetString(bytes[Offset("StartFragment")..Offset("EndFragment")]);
Check(fragment.Contains("R&amp;D") && fragment.Contains("🌱") && fragment.Contains("&amp;b=2"), "Windows HTML clipboard format uses UTF8 byte offsets and escaped link text");
Check(Offset("EndHTML") == bytes.Length, "Windows HTML clipboard end includes the full encoded document");
Check(SharedLinkFormats.PlainText("Revenue", "https://example.test/d/a") == "Revenue (https://example.test/d/a)", "Plain editors retain the actual share URL");
Console.WriteLine($"Passed {checks} Windows assistance logic checks.");
