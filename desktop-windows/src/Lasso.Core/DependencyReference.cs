//  Local dependency references.
//
//  A reference records that a span of text in some other application came from
//  an indexed source. It is local augmentation: the host document is never
//  modified, and no share token exists unless the user explicitly asks for one.
//
//  The anchor is deliberately not a bare offset. Surrounding text changes as the
//  user writes, so a reference stores the phrase plus the text either side of it
//  and relocates itself. When it cannot do so confidently it becomes
//  unresolved rather than attaching to the wrong identical phrase.

using System.Text.Json;
using System.Text.Json.Serialization;

namespace Lasso.Core;

// MARK: - Anchoring

public sealed record TextAnchor
{
    /// The linked phrase exactly as inserted.
    [JsonPropertyName("text")] public string Text { get; init; } = "";
    /// Text immediately before and after it, used to disambiguate repeats.
    [JsonPropertyName("prefixContext")] public string PrefixContext { get; init; } = "";
    [JsonPropertyName("suffixContext")] public string SuffixContext { get; init; } = "";
    /// Where it was when created; only a tie-breaker, never the sole evidence.
    [JsonPropertyName("approximateOffset")] public int ApproximateOffset { get; init; }

    public const int ContextLength = 48;

    /// Builds an anchor from a document and the range the phrase occupies.
    public static TextAnchor? Make(string document, UnitRange range, int documentOffset = 0)
    {
        if (range.Start < 0 || range.End > document.Length
            || range.Start >= range.End || documentOffset < 0)
        {
            return null;
        }
        var prefixStart = Math.Max(0, range.Start - ContextLength);
        var suffixEnd = Math.Min(document.Length, range.End + ContextLength);
        return new TextAnchor
        {
            Text = document.Substring(range.Start, range.Count),
            PrefixContext = document.Substring(prefixStart, range.Start - prefixStart),
            SuffixContext = document.Substring(range.End, suffixEnd - range.End),
            ApproximateOffset = documentOffset + range.Start,
        };
    }
}

public enum AnchorFailure
{
    TextMissing,    // the phrase is no longer present
    Ambiguous,      // repeats that context cannot separate
}

/// Either the range the phrase now occupies, or why it could not be placed.
public readonly struct AnchorResolution
{
    public UnitRange Range { get; }
    public AnchorFailure? Failure { get; }
    public bool IsResolved => Failure is null;

    private AnchorResolution(UnitRange range, AnchorFailure? failure)
    {
        Range = range;
        Failure = failure;
    }

    public static AnchorResolution Resolved(UnitRange range) => new(range, null);
    public static AnchorResolution Unresolved(AnchorFailure failure) => new(default, failure);
}

public static class TextAnchorResolver
{
    /// Minimum matching context characters before a repeated phrase is trusted.
    public const int MinimumEvidence = 3;
    /// Position may only decide when the remembered offset is still plausible…
    public const int MaximumDrift = 200;
    /// …and one candidate is clearly nearer than the next.
    public const int ProximityMargin = 8;

    public static AnchorResolution Resolve(TextAnchor anchor, string document)
    {
        var needle = anchor.Text;
        if (needle.Length == 0) return AnchorResolution.Unresolved(AnchorFailure.TextMissing);

        var occurrences = Indices(needle, document);
        if (occurrences.Count == 0) return AnchorResolution.Unresolved(AnchorFailure.TextMissing);
        // A single occurrence needs no disambiguation.
        if (occurrences.Count == 1)
        {
            return AnchorResolution.Resolved(new UnitRange(occurrences[0], occurrences[0] + needle.Length));
        }

        var prefix = anchor.PrefixContext;
        var suffix = anchor.SuffixContext;
        var scored = occurrences
            .Select(start => (
                Start: start,
                Score: CommonSuffixLength(prefix, document, start)
                     + CommonPrefixLength(suffix, document, start + needle.Length)))
            .ToList();

        var bestScore = scored.Max(entry => entry.Score);
        var rivals = scored.Where(entry => entry.Score == bestScore).ToList();

        if (rivals.Count == 1 && bestScore >= MinimumEvidence)
        {
            return AnchorResolution.Resolved(new UnitRange(rivals[0].Start, rivals[0].Start + needle.Length));
        }

        // Context could not separate them. Position may still decide, but only
        // when the remembered offset is still plausible and one candidate is
        // clearly nearer than the next — repeats can sit a few words apart.
        var byDistance = rivals
            .Select(entry => (entry.Start, Distance: Math.Abs(entry.Start - anchor.ApproximateOffset)))
            .OrderBy(entry => entry.Distance)
            .ToList();
        if (byDistance.Count > 0 && byDistance[0].Distance <= MaximumDrift)
        {
            var runnerUp = byDistance.Count > 1 ? byDistance[1].Distance : int.MaxValue;
            if (runnerUp - byDistance[0].Distance >= ProximityMargin)
            {
                return AnchorResolution.Resolved(
                    new UnitRange(byDistance[0].Start, byDistance[0].Start + needle.Length));
            }
        }
        return AnchorResolution.Unresolved(AnchorFailure.Ambiguous);
    }

    // MARK: Helpers

    /// Every occurrence, compared by exact code unit — the same evidence the
    /// macOS build uses, so no culture-aware collation can widen a match.
    public static List<int> Indices(string needle, string haystack)
    {
        var found = new List<int>();
        if (needle.Length == 0 || haystack.Length < needle.Length) return found;
        for (var start = 0; start <= haystack.Length - needle.Length; start++)
        {
            var matched = true;
            for (var offset = 0; offset < needle.Length; offset++)
            {
                if (haystack[start + offset] != needle[offset])
                {
                    matched = false;
                    break;
                }
            }
            if (matched) found.Add(start);
        }
        return found;
    }

    /// How many trailing characters of <paramref name="context"/> match the
    /// document before <paramref name="end"/>.
    public static int CommonSuffixLength(string context, string document, int end)
    {
        var count = 0;
        while (count < context.Length && end - count - 1 >= 0
               && context[context.Length - 1 - count] == document[end - count - 1])
        {
            count++;
        }
        return count;
    }

    /// How many leading characters of <paramref name="context"/> match the
    /// document from <paramref name="start"/>.
    public static int CommonPrefixLength(string context, string document, int start)
    {
        var count = 0;
        while (count < context.Length && start + count < document.Length
               && context[count] == document[start + count])
        {
            count++;
        }
        return count;
    }
}

// MARK: - The reference itself

/// How a dependency should be drawn, driven by its relationship to the source
/// rather than by the call site.
[JsonConverter(typeof(JsonStringEnumConverter<DependencyVisualState>))]
public enum DependencyVisualState
{
    Healthy,        // linked and matching
    Changed,        // the source value moved on
    Stale,          // the source version is behind
    Missing,        // the source can no longer be resolved
    Unresolved,     // the phrase could not be located in the host
}

public static class DependencyVisualStateExtensions
{
    public static bool IsDrawn(this DependencyVisualState state) =>
        state is not (DependencyVisualState.Unresolved or DependencyVisualState.Missing);

    public static string Name(this DependencyVisualState state) => state switch
    {
        DependencyVisualState.Healthy => "healthy",
        DependencyVisualState.Changed => "changed",
        DependencyVisualState.Stale => "stale",
        DependencyVisualState.Missing => "missing",
        _ => "unresolved",
    };
}

public sealed record DependencyReference
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    /// The indexed object this phrase came from.
    [JsonPropertyName("objectId")] public string ObjectId { get; init; } = "";
    [JsonPropertyName("versionId")] public string? VersionId { get; init; }
    /// Where it was inserted. On Windows the host is identified by its
    /// executable rather than a bundle identifier.
    [JsonPropertyName("hostBundleIdentifier")] public string HostBundleIdentifier { get; init; } = "";
    [JsonPropertyName("hostApplication")] public string HostApplication { get; init; } = "";
    /// Identity of the document/compose surface, so references never appear
    /// over an unrelated window.
    [JsonPropertyName("documentContext")] public string DocumentContext { get; init; } = "";
    [JsonPropertyName("anchor")] public TextAnchor Anchor { get; set; } = new();
    [JsonPropertyName("state")] public DependencyVisualState State { get; set; }
    /// Shown in the inspector without another round trip.
    [JsonPropertyName("label")] public string Label { get; set; } = "";
    [JsonPropertyName("valueText")] public string? ValueText { get; set; }
    [JsonPropertyName("sourcePath")] public string SourcePath { get; set; } = "";
    [JsonPropertyName("sourceLocation")] public string SourceLocation { get; set; } = "";
    /// Stable palette slot shared by every dependency from the same source file.
    [JsonPropertyName("sourceColorSlot")] public int? SourceColorSlot { get; set; }
    [JsonPropertyName("createdAt")] public DateTimeOffset CreatedAt { get; init; }
    [JsonPropertyName("updatedAt")] public DateTimeOffset UpdatedAt { get; set; }

    /// Identity is the reference id alone, as on macOS: a relocated anchor or a
    /// repaired source path is still the same reference.
    public bool Equals(DependencyReference? other) => other is not null && Id == other.Id;
    public override int GetHashCode() => Id.GetHashCode();
}

/// Persistence for local references. Kept separate from resolution so the store
/// can be exercised without any host application present.
public sealed class DependencyReferenceStore
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly List<DependencyReference> _references = [];
    private readonly string _path;

    public IReadOnlyList<DependencyReference> References => _references;

    public DependencyReferenceStore(string path)
    {
        _path = path;
        Load();
    }

    public void Add(DependencyReference reference)
    {
        _references.RemoveAll(existing => existing.Id == reference.Id);
        _references.Add(reference);
        Save();
    }

    public void Remove(string id)
    {
        _references.RemoveAll(existing => existing.Id == id);
        Save();
    }

    public void Update(string id, Action<DependencyReference> transform)
    {
        var index = _references.FindIndex(existing => existing.Id == id);
        if (index < 0) return;
        transform(_references[index]);
        _references[index].UpdatedAt = DateTimeOffset.UtcNow;
        Save();
    }

    /// References belonging to one host document, never any other.
    public List<DependencyReference> ReferencesFor(string context, string bundleIdentifier) =>
        _references
            .Where(reference => reference.DocumentContext == context
                && reference.HostBundleIdentifier == bundleIdentifier)
            .ToList();

    public DependencyReference? Reference(string id) =>
        _references.FirstOrDefault(reference => reference.Id == id);

    private void Load()
    {
        try
        {
            if (!File.Exists(_path)) return;
            var decoded = JsonSerializer.Deserialize<List<DependencyReference>>(
                File.ReadAllText(_path), SerializerOptions);
            if (decoded is not null) _references.AddRange(decoded);
        }
        catch (Exception)
        {
            // A corrupt store is treated as an empty one, never as a crash:
            // the host document is untouched either way.
        }
    }

    private void Save()
    {
        try
        {
            var directory = Path.GetDirectoryName(_path);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            // Written beside the target and moved into place, so an interrupted
            // save cannot leave a half-written list of references behind.
            var temporary = _path + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(_references, SerializerOptions));
            File.Move(temporary, _path, overwrite: true);
        }
        catch (Exception)
        {
            // Persistence is best effort; highlights still work this session.
        }
    }
}
