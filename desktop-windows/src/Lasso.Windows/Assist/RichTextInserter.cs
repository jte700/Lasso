//  Inserting a share as a real hyperlink.
//
//  Rich editors accept a pasted hyperlink; plain ones take the label and the
//  URL as text. Both come off the clipboard, which belongs to the user, so it
//  is borrowed and put back — and only put back if nothing else wrote to it in
//  the meantime, which is exactly what the macOS build checks with the
//  pasteboard change count.
//
//  Isolated here so no other layer depends on clipboard behaviour.

using System.Threading;
using System.Windows;
using System.Windows.Threading;
using Lasso.Core;
using Lasso.Windows.Interop;
using Lasso.Windows.Support;

namespace Lasso.Windows.Assist;

public static class RichTextInserter
{
    /// Selects nothing and pastes: the partial word is erased first, because
    /// UI Automation cannot move a host's selection for us.
    public static async Task<bool> InsertLinkAsync(Dispatcher dispatcher, string label, Uri url,
        int replacing)
    {
        var saved = await dispatcher.InvokeAsync(Borrow).Task.ConfigureAwait(true);
        var placed = await dispatcher.InvokeAsync(() => Place(label, url)).Task.ConfigureAwait(true);
        if (!placed)
        {
            AssistLog.Write("share: the clipboard could not be written; nothing was inserted");
            return false;
        }
        var sequence = NativeMethods.GetClipboardSequenceNumber();

        await Task.Run(() =>
        {
            if (replacing > 0) SyntheticKeyboard.DeleteBackwards(replacing);
            SyntheticKeyboard.Paste();
            Thread.Sleep(250);
        }).ConfigureAwait(true);

        // Give the target application time to read the paste before the
        // clipboard goes back to what the user had.
        _ = dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(async () =>
        {
            await Task.Delay(600);
            if (NativeMethods.GetClipboardSequenceNumber() != sequence) return;
            Restore(saved);
        }));
        return true;
    }

    private static bool Place(string label, Uri url)
    {
        try
        {
            var data = new DataObject();
            data.SetData(DataFormats.Html, ShareFormats.HtmlClipboardFragment(ShareFormats.Html(label, url)));
            data.SetData(DataFormats.Rtf, ShareFormats.Rtf(label, url));
            data.SetData(DataFormats.UnicodeText, ShareFormats.PlainText(label, url));
            Clipboard.SetDataObject(data, copy: true);
            return true;
        }
        catch (Exception)
        {
            // Another application is holding the clipboard open.
            return false;
        }
    }

    private static Dictionary<string, object>? Borrow()
    {
        try
        {
            var existing = Clipboard.GetDataObject();
            if (existing is null) return null;
            var saved = new Dictionary<string, object>();
            foreach (var format in existing.GetFormats())
            {
                try
                {
                    if (existing.GetData(format) is { } value) saved[format] = value;
                }
                catch (Exception)
                {
                    // A format that refuses to be read is simply not restored.
                }
            }
            return saved;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static void Restore(Dictionary<string, object>? saved)
    {
        try
        {
            if (saved is null || saved.Count == 0)
            {
                Clipboard.Clear();
                return;
            }
            var data = new DataObject();
            foreach (var (format, value) in saved) data.SetData(format, value);
            Clipboard.SetDataObject(data, copy: true);
        }
        catch (Exception)
        {
            // The user's clipboard stays as the paste left it; nothing else to do.
        }
    }
}
