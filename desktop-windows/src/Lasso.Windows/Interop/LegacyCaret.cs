//  The caret, for hosts that only publish it the old way.
//
//  UI Automation's text pattern is the primary source for the insertion point,
//  but a plain Win32 edit control — Notepad, a dialog field, countless older
//  applications — reports a degenerate text range with no rectangle while still
//  telling the window manager exactly where its caret is. That is the route
//  tried before the suggestion panel falls back to the control's own frame.

using System.Runtime.InteropServices;
using Lasso.Core;

namespace Lasso.Windows.Interop;

public static class LegacyCaret
{
    /// The caret rectangle of the thread that owns a window, in screen
    /// coordinates. This is what Win32 edit controls answer.
    public static HostRect? FromGuiThread(IntPtr window)
    {
        if (window == IntPtr.Zero) return null;
        var thread = NativeMethods.GetWindowThreadProcessId(window, out _);
        if (thread == 0) return null;

        var info = new NativeMethods.GUITHREADINFO
        {
            cbSize = (uint)Marshal.SizeOf<NativeMethods.GUITHREADINFO>(),
        };
        if (!NativeMethods.GetGUIThreadInfo(thread, ref info)) return null;
        if (info.hwndCaret == IntPtr.Zero) return null;

        var rect = info.rcCaret;
        var width = Math.Max(1, rect.Right - rect.Left);
        var height = rect.Bottom - rect.Top;
        if (height <= 0) return null;

        // rcCaret is relative to the client area of the window that owns it.
        var topLeft = new NativeMethods.POINT { X = rect.Left, Y = rect.Top };
        if (!NativeMethods.ClientToScreen(info.hwndCaret, ref topLeft)) return null;

        return new HostRect(topLeft.X, topLeft.Y, width, height);
    }
}
