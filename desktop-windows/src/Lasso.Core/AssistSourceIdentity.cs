//  Canonical identity for a source-backed suggestion.
//
//  A completion can carry both an owning file path and a human-readable
//  breadcrumb (for example, "Accounting · Supplies · Current Period"). The
//  breadcrumb belongs in the UI; dependency identity must use the owning file
//  so rows, columns, cells, figures, and findings from one document stay one
//  color.

using System.Text;

namespace Lasso.Core;

public static class AssistSourceIdentity
{
    public static string CanonicalPath(string? candidatePath, string? provenanceLabel)
    {
        var candidate = (candidatePath ?? "").Trim();
        if (candidate.Length > 0) return candidate;
        return (provenanceLabel ?? "").Trim();
    }

    public static string Key(string path, string objectId)
    {
        var trimmed = path.Trim();
        if (trimmed.Length == 0) return $"object:{objectId}";
        var components = new List<string>();
        foreach (var component in trimmed.Replace('\\', '/').Split('/'))
        {
            if (component.Length == 0) continue;     // Swift's split drops empties
            if (component == ".") continue;
            if (component == ".." && components.Count > 0 && components[^1] != "..")
            {
                components.RemoveAt(components.Count - 1);
            }
            else
            {
                components.Add(component);
            }
        }
        var normalized = string.Join("/", components)
            .Normalize(NormalizationForm.FormC)
            .ToLowerInvariant();
        return $"file:{normalized}";
    }

    /// Resolves an indexed file to a local path without allowing a candidate
    /// path (or a link inside the project) to escape the indexed root.
    ///
    /// Containment is compared case-insensitively here, unlike the macOS build:
    /// Windows paths are case-insensitive, so a differently-cased project root
    /// is the same folder and must not be treated as an escape.
    public static string? LocalFilePath(
        string projectRoot, string sourcePath, Func<string, bool>? fileExists = null)
    {
        fileExists ??= File.Exists;
        if (!IsAbsolute(projectRoot)) return null;

        string root;
        try
        {
            root = FinalPath(Path.GetFullPath(projectRoot));
        }
        catch (Exception)
        {
            return null;
        }

        var rawSource = sourcePath.Trim();
        if (rawSource.Length == 0) return null;

        // Indexed paths are stored POSIX-style; a Windows separator is accepted
        // and normalized rather than treated as part of a name.
        var normalizedSource = rawSource.Replace('/', Path.DirectorySeparatorChar)
                                        .Replace('\\', Path.DirectorySeparatorChar);

        string resolved;
        try
        {
            var combined = IsAbsolute(normalizedSource)
                ? normalizedSource
                : Path.Combine(root, normalizedSource.TrimStart(Path.DirectorySeparatorChar));
            resolved = FinalPath(Path.GetFullPath(combined));
        }
        catch (Exception)
        {
            return null;
        }

        var rootPrefix = root.EndsWith(Path.DirectorySeparatorChar)
            ? root
            : root + Path.DirectorySeparatorChar;
        if (!resolved.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase)) return null;
        return fileExists(resolved) ? resolved : null;
    }

    /// A drive-rooted path, a UNC share, or a rooted path — anything Windows
    /// resolves without the current directory.
    private static bool IsAbsolute(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return false;
        try
        {
            return Path.IsPathFullyQualified(path);
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    /// Follows directory junctions and symbolic links so a link planted inside
    /// the project cannot point the opener at a file outside it.
    private static string FinalPath(string path)
    {
        try
        {
            FileSystemInfo info = Directory.Exists(path)
                ? new DirectoryInfo(path)
                : new FileInfo(path);
            var target = info.ResolveLinkTarget(returnFinalTarget: true);
            if (target is not null) return Path.GetFullPath(target.FullName);
        }
        catch (Exception)
        {
            // Not a link, or not readable: the fully qualified path stands.
        }
        return path;
    }

    /// Keeps one palette slot per owning source, repairs old collisions, and
    /// preserves the first usable persisted preference for each source.
    public static Dictionary<string, int> ColorAssignments(
        IEnumerable<(string Key, int? Preferred)> sources, int paletteCount, Func<string, int> fallback)
    {
        var assignments = new Dictionary<string, int>();
        if (paletteCount <= 0) return assignments;
        var occupied = new HashSet<int>();

        int Normalized(int slot) => (slot % paletteCount + paletteCount) % paletteCount;

        foreach (var source in sources)
        {
            if (assignments.ContainsKey(source.Key)) continue;
            int slot;
            var preferred = source.Preferred.HasValue ? Normalized(source.Preferred.Value) : (int?)null;
            if (preferred is { } wanted && !occupied.Contains(wanted))
            {
                slot = wanted;
            }
            else
            {
                var available = Enumerable.Range(0, paletteCount).FirstOrDefault(
                    candidate => !occupied.Contains(candidate), -1);
                slot = available >= 0 ? available : Normalized(fallback(source.Key));
            }
            assignments[source.Key] = slot;
            occupied.Add(slot);
        }
        return assignments;
    }

    /// FNV-1a is deterministic across launches; a runtime string hash is not.
    public static int StableSourceColorSlot(string key, int paletteCount)
    {
        if (paletteCount <= 0) return 0;
        var hash = 14_695_981_039_346_656_037UL;
        foreach (var byteValue in Encoding.UTF8.GetBytes(key))
        {
            hash ^= byteValue;
            hash *= 1_099_511_628_211UL;
        }
        return (int)(hash % (ulong)paletteCount);
    }
}

/// Chooses what accepting a source candidate should type. A candidate can
/// carry both a semantic name and a child value; the claim type decides which
/// one the writer is asking for.
public static class AssistSuggestionSemantics
{
    private static readonly HashSet<string> LabelFirst =
        ["ENTITY", "DATASET_REFERENCE", "FIGURE", "TABLE_REFERENCE", "METHOD"];

    public static string InsertionText(string? claimType, string label, string? value)
    {
        if (claimType is not null && LabelFirst.Contains(claimType) && label.Length > 0) return label;
        return value ?? label;
    }
}
