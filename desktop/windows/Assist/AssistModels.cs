using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;

namespace Lasso.Windows.Assist;

public sealed class AssistStateChangedEventArgs(bool enabled, string status) : EventArgs
{
    public bool Enabled { get; } = enabled;
    public string Status { get; } = status;
}

public sealed class SourceOpenRequestedEventArgs(string sourceId, string? versionId, string? fragmentId, bool openSharing = false) : EventArgs
{
    public string SourceId { get; } = sourceId;
    public string? VersionId { get; } = versionId;
    public string? FragmentId { get; } = fragmentId;
    public bool OpenSharing { get; } = openSharing;
    public string? ProjectId { get; init; }
    public string? ShareInsertionId { get; init; }
}

internal sealed record AssistSuggestion(string InsertText, string Label, string Detail, string Path,
    string Location, string? ObjectId, string? VersionId, string? SnapshotId, string? UsageObjectId,
    string ProjectId, string? RankingReason, bool IsContinuation = false, int? ReplaceStart = null, int? ReplaceEnd = null);

internal sealed record AssistPrediction(string Heading, IReadOnlyList<AssistSuggestion> Suggestions);
internal sealed record LinkedSource(string ObjectId, string SnapshotId, string Text);

/// <summary>A verified completion: retain an existing prefix, or replace the exact claim supplied by the engine.</summary>
internal sealed record CompletionPlan(string Before, int PrefixLength, string Suffix, int RemoveLength = 0)
{
    public string CompletedPhrase => RemoveLength > 0 ? Suffix : Before[^PrefixLength..] + Suffix;
    public string ExpectedBeforeCaret => Before[..(Before.Length - RemoveLength)] + Suffix;

    public static CompletionPlan? Create(string before, string insert, bool appendOnly = false, int? replaceStart = null, int? replaceEnd = null)
    {
        // Newlines/tabs in a global suggestion can invoke actions in single-line controls.
        // Keep external insertion to ordinary text; the workspace supports richer edits.
        if (string.IsNullOrWhiteSpace(insert) || insert.Length > 512 ||
            insert.Any(char.IsControl) || !ValidUtf16(insert)) return null;
        if (replaceStart.HasValue || replaceEnd.HasValue)
        {
            if (replaceStart is not int start || replaceEnd != before.Length || start < 0 || start > before.Length ||
                (start < before.Length && char.IsLowSurrogate(before[start]))) return null;
            var typed = before[start..];
            if (insert.StartsWith(typed, StringComparison.OrdinalIgnoreCase))
                return new(before, typed.Length, insert[typed.Length..]);
            return new(before, 0, insert, typed.Length);
        }
        var overlap = 0;
        for (var length = appendOnly ? 0 : Math.Min(before.Length, insert.Length); length > 0; length--)
        {
            var start = before.Length - length;
            if (start > 0 && char.IsLetterOrDigit(before[start - 1]) && char.IsLetterOrDigit(insert[0])) continue;
            if (start < before.Length && char.IsLowSurrogate(before[start])) continue;
            if (length < insert.Length && char.IsLowSurrogate(insert[length])) continue;
            if (string.Equals(before[start..], insert[..length], StringComparison.OrdinalIgnoreCase))
            {
                overlap = length;
                break;
            }
        }
        var suffix = insert[overlap..];
        return new CompletionPlan(before, overlap, suffix);
    }

    public static bool ValidUtf16(string text)
    {
        for (var i = 0; i < text.Length; i++)
        {
            if (char.IsHighSurrogate(text[i]))
            {
                if (++i >= text.Length || !char.IsLowSurrogate(text[i])) return false;
            }
            else if (char.IsLowSurrogate(text[i])) return false;
        }
        return true;
    }

    public bool Verify(string afterBeforeCaret, string beforeTail, string afterTail)
    {
        var expected = ExpectedBeforeCaret;
        // UIA providers count text units differently. Compare bounded overlapping evidence,
        // including the entire inserted suffix, and the untouched text after the caret.
        return afterBeforeCaret.Length >= CompletedPhrase.Length && afterBeforeCaret.Length <= expected.Length &&
            Equivalent(expected[^afterBeforeCaret.Length..], afterBeforeCaret) &&
            Equivalent(beforeTail, afterTail);
    }

    private static bool Equivalent(string left, string right) =>
        left.Length == right.Length && left.Zip(right).All(pair => Canonical(pair.First) == Canonical(pair.Second));

    private static char Canonical(char value) => value is '\u00a0' or '\u2007' or '\u202f' ? ' ' : value;
}

internal static class AssistPayload
{
    public static AssistPrediction ParsePrediction(JsonElement root, string projectId)
    {
        var prediction = Child(root, "prediction");
        var heading = Text(prediction, "workspaceHeading") ?? "Suggestions from your workspace";
        var results = new List<AssistSuggestion>();
        var completion = Child(prediction, "completion");
        var insert = Text(completion, "insertText");
        if (!string.IsNullOrWhiteSpace(insert))
        {
            var candidate = Child(completion, "dependencyCandidate");
            results.Add(new(insert, insert.Trim(), "Sentence completion", Text(Child(completion, "source"), "path") ?? "",
                "", null, null, null, Text(candidate, "id"), projectId,
                Text(Child(candidate, "ranking"), "reason"), true));
        }
        foreach (var group in new[] { "workspaceCompletions", "sourceCompletions" })
        {
            foreach (var entry in Items(prediction, group))
            {
                var candidate = Child(entry, "dependencyCandidate");
                insert = Text(entry, "replacementText") ?? Text(entry, "insertText");
                if (string.IsNullOrWhiteSpace(insert)) continue;
                var path = Text(candidate, "path");
                if (string.IsNullOrWhiteSpace(path)) path = Text(entry, "provenanceLabel");
                results.Add(Suggestion(candidate, insert, insert, Text(candidate, "valueText") ?? Text(entry, "category") ?? "",
                    path ?? "", projectId) with { ReplaceStart = Number(entry, "claimStart"), ReplaceEnd = Number(entry, "claimEnd") });
            }
        }
        foreach (var claim in Items(prediction, "claims"))
        {
            foreach (var candidate in Items(claim, "candidates"))
            {
                var label = Text(candidate, "label") ?? "";
                var value = Text(candidate, "valueText") ?? Text(candidate, "displayValue");
                insert = Text(claim, "type") is "ENTITY" or "DATASET_REFERENCE" or "FIGURE" or "TABLE_REFERENCE" or "METHOD" or "STUDY_VARIABLE"
                    && label.Length > 0 ? label : value ?? label;
                if (string.IsNullOrWhiteSpace(insert)) continue;
                results.Add(Suggestion(candidate, insert, label, value ?? Text(candidate, "objectType") ?? "",
                    Text(candidate, "path") ?? "", projectId) with { ReplaceStart = Number(claim, "start"), ReplaceEnd = Number(claim, "end") });
            }
        }
        // Identity belongs to the indexed object/file, never to its display breadcrumb.
        return new(heading, results.Where(result => result.InsertText.Length <= 512)
            .DistinctBy(result => (result.InsertText, result.ObjectId)).Take(5).ToArray());
    }

    private static AssistSuggestion Suggestion(JsonElement candidate, string insert, string label, string detail, string path, string project) =>
        new(insert, label, detail, path, Location(candidate), Text(candidate, "id"), Text(candidate, "versionId"),
            Text(candidate, "snapshotId"), Text(candidate, "id"), project, Text(Child(candidate, "ranking"), "reason"));

    public static string Location(JsonElement candidate)
    {
        var anchor = Child(candidate, "anchor");
        var metadata = Child(candidate, "metadata");
        var sheet = Text(anchor, "sheet") ?? Text(metadata, "sheet") ?? "";
        if (Number(anchor, "rowIndex") is int row && Number(anchor, "columnIndex") is int col && row >= 0 && col is >= 0 and < 16384)
            return (sheet.Length > 0 ? sheet + "!" : "") + Column(col) + row.ToString(CultureInfo.InvariantCulture);
        if ((Number(anchor, "pageNumber") ?? Number(metadata, "pageNumber")) is int page)
            return "Page " + page.ToString(CultureInfo.InvariantCulture);
        var rowKey = Text(anchor, "rowKey") ?? Text(metadata, "rowKey");
        return string.IsNullOrWhiteSpace(rowKey) ? sheet : string.Join(" · ", new[] { sheet, rowKey }.Where(s => s.Length > 0));
    }

    private static string Column(int column)
    {
        var result = "";
        do { result = (char)('A' + column % 26) + result; column = column / 26 - 1; } while (column >= 0);
        return result;
    }

    public static string ParsePreview(JsonElement root)
    {
        var preview = Child(root, "preview");
        var rows = Items(preview, "rows").Take(5).ToArray();
        if (rows.Length > 0)
        {
            var lines = new List<string>();
            var headers = Items(preview, "headers").Select(ValueText).Take(5).ToArray();
            if (headers.Length > 0) lines.Add(string.Join("    ", headers));
            foreach (var row in rows)
                lines.Add(string.Join("    ", Items(row, "cells").Take(5).Select(cell =>
                    (Child(cell, "cited").ValueKind == JsonValueKind.True ? "● " : "") + (Text(cell, "value") ?? ValueText(cell)))));
            return Limit(string.Join(Environment.NewLine, lines), 700);
        }
        var source = Child(root, "source");
        return Limit(Text(preview, "unavailableReason") ?? Text(preview, "text") ?? Text(source, "valueText") ??
            Text(source, "label") ?? "Open the source to view its document context.", 700);
    }

    public static JsonElement Child(JsonElement parent, string name) =>
        parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var value) ? value : default;
    public static string? Text(JsonElement parent, string name) => Child(parent, name) is var value && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static int? Number(JsonElement parent, string name) => Child(parent, name) is var value && value.TryGetInt32Safe(out var number) ? number : null;
    private static bool TryGetInt32Safe(this JsonElement value, out int number)
    {
        number = 0;
        return value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out number);
    }
    public static IEnumerable<JsonElement> Items(JsonElement parent, string name) =>
        Child(parent, name) is var value && value.ValueKind == JsonValueKind.Array ? value.EnumerateArray() : [];
    private static string ValueText(JsonElement value) => value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : value.ValueKind is JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False ? value.ToString() : "";
    private static string Limit(string value, int length) => value.Length <= length ? value : value[..length] + "…";
}
