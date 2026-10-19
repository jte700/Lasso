using System;

namespace Lasso.Windows.Assist;

// Keep a small amount of local context to distinguish repeated accepted words.
// Ambiguous or edited anchors disappear instead of opening unrelated evidence.
public sealed record TextAnchor(string Text, string Prefix, string Suffix)
{
    public static TextAnchor AtCaret(string before, string after, string phrase)
    {
        var preceding = before[..Math.Max(0, before.Length - phrase.Length)];
        return new(phrase, preceding[^Math.Min(32, preceding.Length)..], after[..Math.Min(32, after.Length)]);
    }

    public int Locate(string document)
    {
        if (string.IsNullOrEmpty(Text)) return -1;
        var match = -1;
        for (var offset = 0; offset <= document.Length - Text.Length;)
        {
            var index = document.IndexOf(Text, offset, StringComparison.Ordinal);
            if (index < 0) break;
            var prefixMatches = Prefix.Length == 0 ? index == 0 : index >= Prefix.Length && document.AsSpan(index - Prefix.Length, Prefix.Length).SequenceEqual(Prefix.AsSpan());
            var end = index + Text.Length;
            var suffixMatches = Suffix.Length == 0 || (end + Suffix.Length <= document.Length && document.AsSpan(end, Suffix.Length).SequenceEqual(Suffix.AsSpan()));
            if (prefixMatches && suffixMatches)
            {
                if (match >= 0) return -1;
                match = index;
            }
            offset = index + Text.Length;
        }
        return match;
    }
}
