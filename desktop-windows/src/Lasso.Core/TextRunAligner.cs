//  Aligning a host's visible text runs with the editor's own value.
//
//  Rich browser editors expose the whole text on the editor element but refuse
//  to measure a character range on it, while each text leaf underneath will
//  happily measure its own. To turn a document range into screen rectangles the
//  leaves have to be laid back over the document string first.
//
//  Contenteditable inserts paragraph separators between leaves, and those
//  separators have no leaf of their own. Searching ahead past other visible text
//  is refused: that could attach a reference to a different occurrence of the
//  same word. Missing or stale runs fail closed, returning null, so nothing is
//  ever highlighted on a guess.

namespace Lasso.Core;

public static class TextRunAligner
{
    /// LF, CR, and the Unicode line and paragraph separators, written as code
    /// points so the source stays plain ASCII.
    private const char LineFeed = (char)0x000A;
    private const char CarriageReturn = (char)0x000D;
    private const char LineSeparator = (char)0x2028;
    private const char ParagraphSeparator = (char)0x2029;

    private static bool IsLineBreak(char unit) =>
        unit is LineFeed or CarriageReturn or LineSeparator or ParagraphSeparator;

    /// The document range each run occupies, or null when the runs cannot be
    /// laid over the text exactly and in order.
    public static List<UnitRange>? ElementRanges(IReadOnlyList<string> runs, string text)
    {
        var offset = 0;
        var ranges = new List<UnitRange>(runs.Count);

        foreach (var run in runs)
        {
            if (run.Length == 0) return null;

            bool Matches() =>
                offset + run.Length <= text.Length
                && text.AsSpan(offset, run.Length).SequenceEqual(run.AsSpan());

            // Step over paragraph separators the browser generated, nothing else.
            while (!Matches() && offset < text.Length && IsLineBreak(text[offset])) offset++;
            if (!Matches()) return null;
            ranges.Add(new UnitRange(offset, offset + run.Length));
            offset += run.Length;
        }

        // Anything left over must be trailing empty paragraphs; visible text the
        // runs did not account for means the subtree is stale or incomplete.
        for (var index = offset; index < text.Length; index++)
        {
            if (!IsLineBreak(text[index])) return null;
        }
        return ranges;
    }
}
