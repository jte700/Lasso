//  What the suggestion panel offers, and how a prediction response becomes rows.
//
//  Parsing, casing, and location formatting live here rather than in the panel so
//  they can be checked against recorded server responses without a host
//  application or a window, exactly as the macOS build tests them.

using System.Text.Json;

namespace Lasso.Core;

public sealed record AssistSuggestion(
    /// What gets typed into the focused app.
    string InsertText,
    /// Headline shown in the panel.
    string Label,
    /// Value or context, shown dim.
    string Detail,
    /// Originating source file.
    string Path,
    /// Exact sheet/cell, page, row, or passage.
    string Location,
    /// UTF-16 offset, within the captured window, of the partial word this
    /// suggestion replaces. Null means "insert at the caret, replacing nothing".
    int? ReplaceFrom,
    /// Indexed object behind the suggestion. Required to create a share; absent
    /// for plain sentence completions, which have nothing to link to.
    string? ObjectId,
    string? VersionId,
    string? SnapshotId,
    /// Sentence completions retain source identity for usage without becoming shareable.
    string? UsageObjectId,
    string ProjectId,
    string? RankingReason)
{
    public bool IsShareable => ObjectId is not null;
}

/// What `Tab` does. Sharing is never implicit: the default inserts plain text
/// and creates no public token.
public enum InsertionMode
{
    Plain,
    Ask,
    Share,
}

public static class InsertionModeExtensions
{
    public static string Title(this InsertionMode mode) => mode switch
    {
        InsertionMode.Plain => "Plain text by default",
        InsertionMode.Ask => "Ask before sharing",
        InsertionMode.Share => "Share link by default",
        _ => "Plain text by default",
    };

    public static string Name(this InsertionMode mode) => mode switch
    {
        InsertionMode.Plain => "plain",
        InsertionMode.Ask => "ask",
        InsertionMode.Share => "share",
        _ => "plain",
    };

    public static InsertionMode Parse(string? name) => name switch
    {
        "ask" => InsertionMode.Ask,
        "share" => InsertionMode.Share,
        _ => InsertionMode.Plain,
    };
}

public static class PredictionParser
{
    /// Turns a prediction payload into at most four insertable rows.
    public static List<AssistSuggestion> Parse(ReadOnlySpan<byte> data, int windowLength, string projectId)
    {
        var results = new List<AssistSuggestion>();
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(data.ToArray());
        }
        catch (JsonException)
        {
            return results;
        }
        using (document)
        {
            if (JsonReading.Object(document.RootElement, "prediction") is not { } prediction) return results;

            // A sentence completion continues what is already typed, so it
            // replaces nothing.
            if (JsonReading.Object(prediction, "completion") is { } completion
                && JsonReading.String(completion, "insertText") is { Length: > 0 } insert)
            {
                var candidate = JsonReading.Object(completion, "dependencyCandidate");
                var source = JsonReading.Object(completion, "source") is { } sourceObject
                    ? JsonReading.String(sourceObject, "path") ?? ""
                    : "";
                results.Add(new AssistSuggestion(
                    InsertText: insert,
                    Label: insert.Trim(' '),
                    Detail: "sentence",
                    Path: source,
                    Location: "",
                    ReplaceFrom: null,
                    ObjectId: null, VersionId: null, SnapshotId: null,
                    UsageObjectId: candidate is { } usage ? JsonReading.String(usage, "id") : null,
                    ProjectId: projectId,
                    RankingReason: RankingReason(candidate)));
            }

            // Once a source is linked the server answers with its downstream
            // values — the rows, columns and findings belonging to it — rather
            // than with the same phrase again.
            foreach (var group in new[] { "workspaceCompletions", "sourceCompletions" })
            {
                foreach (var entry in JsonReading.Array(prediction, group))
                {
                    var candidate = JsonReading.Object(entry, "dependencyCandidate");
                    var insertText = JsonReading.String(entry, "replacementText")
                        ?? JsonReading.String(entry, "insertText") ?? "";
                    if (insertText.Length == 0) continue;
                    results.Add(new AssistSuggestion(
                        InsertText: insertText,
                        Label: insertText,
                        Detail: (candidate is { } valued ? JsonReading.String(valued, "valueText") : null)
                            ?? JsonReading.String(entry, "category") ?? "",
                        Path: AssistSourceIdentity.CanonicalPath(
                            candidate is { } pathed ? JsonReading.String(pathed, "path") : null,
                            JsonReading.String(entry, "provenanceLabel")),
                        Location: SourceLocation(candidate),
                        ReplaceFrom: null,
                        ObjectId: candidate is { } identified ? JsonReading.String(identified, "id") : null,
                        VersionId: candidate is { } versioned ? JsonReading.String(versioned, "versionId") : null,
                        SnapshotId: candidate is { } snapshotted ? JsonReading.String(snapshotted, "snapshotId") : null,
                        UsageObjectId: candidate is { } used ? JsonReading.String(used, "id") : null,
                        ProjectId: projectId,
                        RankingReason: RankingReason(candidate)));
                    if (results.Count >= 5) break;
                }
                if (results.Count >= 5) break;
            }

            foreach (var claim in JsonReading.Array(prediction, "claims"))
            {
                // Only swap out the word when the claim actually runs to the
                // caret. If anything follows it — a space, say — this is a
                // plain insertion.
                var claimStart = JsonReading.Int(claim, "start");
                var claimEnd = JsonReading.Int(claim, "end");
                var start = claimEnd == windowLength ? claimStart : null;
                var claimType = JsonReading.String(claim, "type");
                foreach (var candidate in JsonReading.Array(claim, "candidates"))
                {
                    var label = JsonReading.String(candidate, "label") ?? "";
                    var value = JsonReading.String(candidate, "valueText")
                        ?? JsonReading.String(candidate, "displayValue");
                    var path = JsonReading.String(candidate, "path") ?? "";
                    var insertText = AssistSuggestionSemantics.InsertionText(claimType, label, value);
                    if (insertText.Length == 0) continue;
                    results.Add(new AssistSuggestion(
                        InsertText: insertText,
                        Label: label,
                        Detail: value ?? JsonReading.String(candidate, "objectType") ?? "",
                        Path: path,
                        Location: SourceLocation(candidate),
                        ReplaceFrom: start,
                        ObjectId: JsonReading.String(candidate, "id"),
                        VersionId: JsonReading.String(candidate, "versionId"),
                        SnapshotId: JsonReading.String(candidate, "snapshotId"),
                        UsageObjectId: JsonReading.String(candidate, "id"),
                        ProjectId: projectId,
                        RankingReason: RankingReason(candidate)));
                    if (results.Count >= 5) break;
                }
                if (results.Count >= 5) break;
            }
        }
        return results.Take(4).ToList();
    }

    /// What the server is offering: "values for Office Supplies" once a source
    /// is linked, otherwise the general heading.
    public static string? Heading(ReadOnlySpan<byte> data)
    {
        try
        {
            using var document = JsonDocument.Parse(data.ToArray());
            if (JsonReading.Object(document.RootElement, "prediction") is not { } prediction) return null;
            if (JsonReading.String(prediction, "workspaceHeading") is { Length: > 0 } workspace)
            {
                return workspace.ToLowerInvariant();
            }
            if (JsonReading.Object(prediction, "sourceContext") is { } context
                && JsonReading.Object(context, "source") is { } source
                && JsonReading.String(source, "label") is { } label)
            {
                return $"components from {label}".ToLowerInvariant();
            }
            return null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string? RankingReason(JsonElement? candidate) =>
        candidate is { } element && JsonReading.Object(element, "ranking") is { } ranking
            ? JsonReading.String(ranking, "reason")
            : null;

    public static string SourceLocation(JsonElement? candidate)
    {
        if (candidate is not { } element) return "";
        var anchor = JsonReading.Object(element, "anchor");
        var metadata = JsonReading.Object(element, "metadata");

        string? FromEither(string key) =>
            (anchor is { } a ? JsonReading.String(a, key) : null)
            ?? (metadata is { } m ? JsonReading.String(m, key) : null);
        int? IntFromEither(string key) =>
            (anchor is { } a ? JsonReading.Int(a, key) : null)
            ?? (metadata is { } m ? JsonReading.Int(m, key) : null);

        var sheet = FromEither("sheet") ?? "";
        var row = anchor is { } anchorRow ? JsonReading.Int(anchorRow, "rowIndex") : null;
        var column = anchor is { } anchorColumn ? JsonReading.Int(anchorColumn, "columnIndex") : null;
        if (row is { } rowIndex && column is { } columnIndex)
        {
            var cell = SpreadsheetColumn(columnIndex) + rowIndex.ToString();
            return sheet.Length == 0 ? cell : sheet + "!" + cell;
        }
        if (IntFromEither("pageNumber") is { } page) return "p. " + page;
        if (FromEither("rowKey") is { Length: > 0 } rowKey)
        {
            return sheet.Length == 0 ? rowKey : sheet + " · " + rowKey;
        }
        return sheet;
    }

    /// Spreadsheet column letters: 0 → A, 25 → Z, 26 → AA.
    public static string SpreadsheetColumn(int index)
    {
        var current = index;
        var label = "";
        do
        {
            label = (char)('A' + current % 26) + label;
            current = current / 26 - 1;
        }
        while (current >= 0);
        return label;
    }
}

public static class AssistCasing
{
    /// The run of characters before the caret, used only to decide casing.
    public static string TrailingWord(string window)
    {
        var start = window.Length;
        while (start > 0 && window[start - 1] != ' ' && window[start - 1] != '\n') start--;
        return window[start..];
    }

    /// Source labels are stored in title case ("Office Supplies"). Dropped into
    /// the middle of a sentence after a lower-case word, that reads wrong, so
    /// plainly capitalised words are lowered. Acronyms, mixed-case words and
    /// anything containing digits keep their original form.
    public static string MatchCasing(string insertion, string typed, string window, int index)
    {
        if (typed.Length == 0 || typed != typed.ToLowerInvariant()) return insertion;
        var before = window[..Math.Max(0, Math.Min(index, window.Length))].Trim();
        // Start of a sentence keeps its capital, and so does the very beginning
        // of a document, where there is no preceding word to agree with.
        if (before.Length == 0) return insertion;
        if (".!?:".Contains(before[^1])) return insertion;

        static string LowerIfPlainTitleCase(string word)
        {
            if (word.Length == 0 || !char.IsUpper(word[0])) return word;
            if (word.Length <= 1) return word;
            var rest = word.AsSpan(1);
            foreach (var character in rest)
            {
                if (!char.IsLower(character) && character != '\'' && character != '-') return word;
            }
            return char.ToLowerInvariant(word[0]) + word[1..];
        }

        return string.Join(" ", insertion.Split(' ').Select(LowerIfPlainTitleCase));
    }
}
