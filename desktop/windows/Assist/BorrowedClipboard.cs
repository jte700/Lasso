using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows;

namespace Lasso.Windows.Assist;

// Rich insertion borrows the clipboard on the UI thread and restores it only
// if nobody has copied something else while the host processes the paste.
internal sealed class BorrowedClipboard
{
    private readonly System.Windows.DataObject saved = new();
    private readonly uint sequence;
    private readonly bool hadData;
    internal BorrowedClipboard(string label, string url)
    {
        var before = GetClipboardSequenceNumber();
        var previous = System.Windows.Clipboard.GetDataObject();
        if (previous != null)
        {
            foreach (var format in previous.GetFormats(false))
            {
                var value = previous.GetData(format, false);
                if (value is MemoryStream stream) value = new MemoryStream(stream.ToArray());
                if (value != null) { saved.SetData(format, value); hadData = true; }
            }
        }
        if (GetClipboardSequenceNumber() != before) throw new InvalidOperationException("The clipboard changed. Try inserting again.");
        var content = new System.Windows.DataObject();
        content.SetData(System.Windows.DataFormats.Html, SharedLinkFormats.HtmlClipboard(label, url));
        content.SetData(System.Windows.DataFormats.UnicodeText, SharedLinkFormats.PlainText(label, url));
        System.Windows.Clipboard.SetDataObject(content, true);
        sequence = GetClipboardSequenceNumber();
    }
    internal bool Unchanged => GetClipboardSequenceNumber() == sequence;
    internal async Task RestoreAsync()
    {
        await Task.Delay(650);
        if (!Unchanged) return;
        try { if (hadData) System.Windows.Clipboard.SetDataObject(saved, true); else System.Windows.Clipboard.Clear(); }
        catch (ExternalException) { /* Another application owns the clipboard. */ }
    }
    [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
}
