using System;
using System.Net;
using System.Text;

namespace Lasso.Windows.Assist;

internal static class SharedLinkFormats
{
    private static string Escape(string value) => value.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");
    internal static string PlainText(string label, string url) => $"{label} ({url})";
    internal static string HtmlClipboard(string label, string url)
    {
        var fragment = $"<a href=\"{Escape(url)}\">{Escape(label)}</a>";
        const string start = "<html><body><!--StartFragment-->";
        const string end = "<!--EndFragment--></body></html>";
        const string format = "Version:0.9\r\nStartHTML:{0:D10}\r\nEndHTML:{1:D10}\r\nStartFragment:{2:D10}\r\nEndFragment:{3:D10}\r\n";
        var headerLength = Encoding.UTF8.GetByteCount(string.Format(format, 0, 0, 0, 0));
        var fragmentStart = headerLength + Encoding.UTF8.GetByteCount(start);
        var fragmentEnd = fragmentStart + Encoding.UTF8.GetByteCount(fragment);
        return string.Format(format, headerLength, fragmentEnd + Encoding.UTF8.GetByteCount(end), fragmentStart, fragmentEnd) + start + fragment + end;
    }
}
