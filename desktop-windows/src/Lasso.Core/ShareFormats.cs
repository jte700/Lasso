//  Share scopes, and the clipboard representations a hyperlink is pasted as.
//
//  Sharing is deliberately ordered: create the record, build the URL, insert the
//  link, verify the insertion, and revoke the record if the insertion did not
//  land. The formats themselves are pure text, so what a recipient's document
//  receives can be asserted without a clipboard or a host application.

using System.Text;

namespace Lasso.Core;

public enum ShareAccessScope
{
    Document,
    Indexed,
    Redacted,
}

public enum ShareRedactionEffect
{
    Blur,
    Blank,
}

public static class ShareEnumNames
{
    /// Wire values for the local share API, unchanged from the macOS build.
    public static string Name(this ShareAccessScope scope) => scope switch
    {
        ShareAccessScope.Indexed => "INDEXED",
        ShareAccessScope.Redacted => "REDACTED",
        _ => "DOCUMENT",
    };

    public static string Name(this ShareRedactionEffect effect) =>
        effect == ShareRedactionEffect.Blank ? "BLANK" : "BLUR";
}

public static class ShareScopes
{
    /// A passage of prose says little on its own, so these are sent whole or
    /// redacted. The server's WRITING_TYPES in object-share.js is the same list.
    private static readonly HashSet<string> Writing = new(StringComparer.OrdinalIgnoreCase)
    {
        ".pdf", ".docx", ".txt", ".tex", ".bib", ".ris", ".enw", ".nbib", ".log", ".md", ".mdx", ".qmd", ".rmd", ".rst",
    };

    public static bool OffersCitedPart(string filename) => !Writing.Contains(Path.GetExtension(filename));
}

public sealed record ShareRedaction(
    string Kind,
    int? Sheet,
    int? Row,
    int? Column,
    int? Block,
    ShareRedactionEffect Effect)
{
    public Dictionary<string, object> Payload()
    {
        var value = new Dictionary<string, object>
        {
            ["kind"] = Kind,
            ["effect"] = Effect.Name(),
        };
        if (Sheet is { } sheet) value["sheet"] = sheet;
        if (Row is { } row) value["row"] = row;
        if (Column is { } column) value["column"] = column;
        if (Block is { } block) value["block"] = block;
        return value;
    }
}

public sealed record ShareConfiguration(ShareAccessScope Scope, IReadOnlyList<ShareRedaction> Redactions)
{
    public static readonly ShareConfiguration EntireDocument =
        new(ShareAccessScope.Document, []);
}

public sealed record DependencyShare(string Token, Uri Url);

/// Rich-text representations for applications that accept pasted markup, which
/// is how a browser compose field receives a hyperlink. Isolated here so no
/// other layer depends on clipboard behaviour.
public static class ShareFormats
{
    public static string EscapeHtml(string value) => value
        .Replace("&", "&amp;")
        .Replace("<", "&lt;")
        .Replace(">", "&gt;")
        .Replace("\"", "&quot;");

    /// Only the label is clickable; no raw URL is shown.
    public static string Html(string label, Uri url) =>
        $"<a href=\"{EscapeHtml(url.AbsoluteUri)}\">{EscapeHtml(label)}</a>";

    public static string PlainText(string label, Uri url) => $"{label} ({url.AbsoluteUri})";

    /// A hyperlink field, which is how Word, Outlook, and WordPad receive a
    /// clickable label from the clipboard. Non-ASCII characters are escaped as
    /// \u code points so the label survives a host that reads RTF as ANSI.
    public static string Rtf(string label, Uri url) =>
        "{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fnil Segoe UI;}}\\f0\\fs22 "
        + "{\\field{\\*\\fldinst{HYPERLINK \"" + EscapeRtf(url.AbsoluteUri) + "\"}}"
        + "{\\fldrslt{\\ul\\cf1 " + EscapeRtf(label) + "}}}}";

    private static string EscapeRtf(string value)
    {
        var builder = new StringBuilder(value.Length + 16);
        foreach (var character in value)
        {
            switch (character)
            {
                case '\\': builder.Append("\\\\"); break;
                case '{': builder.Append("\\{"); break;
                case '}': builder.Append("\\}"); break;
                case '\n': builder.Append("\\par "); break;
                case '\r': break;
                default:
                    if (character < 128) builder.Append(character);
                    else builder.Append("\\u").Append((short)character).Append('?');
                    break;
            }
        }
        return builder.ToString();
    }

    /// The CF_HTML clipboard format Windows expects: a byte-offset header
    /// followed by the fragment. Offsets are computed over the UTF-8 encoding,
    /// which is what the header's byte counts refer to.
    public static string HtmlClipboardFragment(string html)
    {
        const string header =
            "Version:0.9\r\nStartHTML:{0:00000000}\r\nEndHTML:{1:00000000}\r\n"
            + "StartFragment:{2:00000000}\r\nEndFragment:{3:00000000}\r\n";
        const string prefix = "<html><body>\r\n<!--StartFragment-->";
        const string suffix = "<!--EndFragment-->\r\n</body></html>";

        var headerLength = Encoding.UTF8.GetByteCount(string.Format(header, 0, 0, 0, 0));
        var startHtml = headerLength;
        var startFragment = startHtml + Encoding.UTF8.GetByteCount(prefix);
        var endFragment = startFragment + Encoding.UTF8.GetByteCount(html);
        var endHtml = endFragment + Encoding.UTF8.GetByteCount(suffix);
        return string.Format(header, startHtml, endHtml, startFragment, endFragment)
            + prefix + html + suffix;
    }
}
