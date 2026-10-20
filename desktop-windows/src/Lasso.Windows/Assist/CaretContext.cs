//  What was read out of the focused editor.
//
//  The macOS counterpart carries an AXUIElement; here it is the UI Automation
//  element plus the window and process that own it, because on Windows those
//  are what decide whether a popup still belongs to the surface it was opened
//  for.

using System.Windows.Automation;
using Lasso.Core;

namespace Lasso.Windows.Assist;

public sealed record CaretContext(
    /// The text immediately before the caret, at most 1,200 UTF-16 units.
    string Text,
    /// The caret's offset within Text, which is always its length: the window
    /// ends at the caret.
    int Cursor,
    /// Absolute UTF-16 offset of the first character in Text, or -1 when the
    /// host cannot say where the window starts.
    int WindowStart,
    /// Caret offset in the document's own units, or -1 when the host exposes no
    /// addressable offsets. Text may still be readable without it.
    int AbsoluteCaret,
    HostRect? CaretRect,
    AutomationElement Element,
    /// Stable identity of the element, used to tell "the same editor" from
    /// "another editor that happens to sit in the same place".
    int[] RuntimeId,
    IntPtr WindowHandle,
    int ProcessId,
    /// Application and control, for the typing log.
    string Diagnosis,
    /// Executable name of the host, which is how a Windows reference records
    /// which application it belongs to.
    string Application,
    /// Stable within one document or compose surface; changes when the user
    /// moves to another.
    string DocumentContext)
{
    public bool IsAddressable => AbsoluteCaret >= 0;
}
