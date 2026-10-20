//  The suggestion panel's window.
//
//  A Windows 11 flyout: no caption, rounded corners drawn by the compositor,
//  an acrylic backdrop, a drop shadow, and — critically — it never takes focus.
//  The user stays in their own editor the whole time, which is what makes Tab
//  reach the panel while every other key reaches their document.
//
//  Unlike the macOS panel there is no beak pointing at the caret. Windows does
//  not draw one on flyouts, IME candidate lists, or suggestion surfaces, so the
//  panel simply sits under the caret and flips above it when there is no room.
//
//  Positioning is done in physical pixels through SetWindowPos rather than in
//  WPF's device-independent units, because caret rectangles arrive in physical
//  pixels from another process and the two monitors involved may have different
//  scale factors.

using System.Windows;
using System.Windows.Interop;
using Lasso.Core;
using Lasso.Windows.Interop;

namespace Lasso.Windows.Assist;

internal sealed class AssistFlyout : Window
{
    private const int CaretGap = 6;

    private readonly AssistFlyoutContent _content = new();
    private bool _styled;

    public AssistFlyoutContent Panel => _content;

    public AssistFlyout()
    {
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        ShowActivated = false;
        Topmost = true;
        // Acrylic is drawn by the compositor, which a layered transparent
        // window would disable, so the window stays opaque to WPF and the
        // backdrop shows through a transparent background instead.
        AllowsTransparency = false;
        Background = null;
        SizeToContent = SizeToContent.Manual;
        Title = "Lasso suggestions";
        Content = _content;

        SourceInitialized += OnSourceInitialized;
    }

    private void OnSourceInitialized(object? sender, EventArgs args)
    {
        var handle = new WindowInteropHelper(this).Handle;
        if (handle == IntPtr.Zero) return;

        // Never activate, and stay out of Alt+Tab and the taskbar.
        var style = NativeMethods.GetWindowLong(handle, NativeMethods.GWL_EXSTYLE);
        NativeMethods.SetWindowLong(handle, NativeMethods.GWL_EXSTYLE,
            style | NativeMethods.WS_EX_NOACTIVATE | NativeMethods.WS_EX_TOOLWINDOW);

        WindowComposition.Apply(this, Backdrop.Acrylic, CornerStyle.Round);
        _styled = true;
    }

    /// Re-reads the system palette and repaints, after a theme or accent change.
    public void ApplySystemTheme()
    {
        FluentPalette.Refresh();
        if (_styled)
        {
            var handle = new WindowInteropHelper(this).Handle;
            if (handle != IntPtr.Zero) WindowComposition.SetDarkCaption(handle, FluentPalette.Current.IsDark);
        }
        _content.Refresh();
    }

    /// Lays the panel out and places it against a caret rectangle given in
    /// physical screen pixels. Passing null falls back to the pointer, which is
    /// what the macOS panel does when a host reports no caret.
    public void PlaceNear(HostRect? caret)
    {
        _content.Refresh();

        var anchor = caret ?? PointerAnchor();
        var monitor = MonitorFor(anchor);
        var scale = MonitorScale(monitor);
        var work = WorkArea(monitor);

        // Below the caret by preference, flipping above or to the leading side
        // when the work area runs out. The rules are in Lasso.Core so they can
        // be tested without a window.
        var placed = FlyoutPlacement.Place(
            anchor,
            _content.PanelWidth * scale,
            _content.PanelHeight * scale,
            HostRect.FromEdges(work.Left, work.Top, work.Right, work.Bottom),
            CaretGap * scale);

        var x = (int)Math.Round(placed.MinX);
        var y = (int)Math.Round(placed.MinY);
        var width = (int)Math.Round(placed.Width);
        var height = (int)Math.Round(placed.Height);

        var handle = new WindowInteropHelper(this).Handle;
        if (handle == IntPtr.Zero)
        {
            // Not realized yet: WPF needs a size before the first show.
            Width = _content.PanelWidth;
            Height = _content.PanelHeight;
            Left = x / scale;
            Top = y / scale;
            return;
        }
        NativeMethods.SetWindowPos(handle, NativeMethods.HWND_TOPMOST, x, y, width, height,
            NativeMethods.SWP_NOACTIVATE);
    }

    /// Shows the panel without stealing focus from the host editor.
    public void Present(HostRect? caret)
    {
        if (!IsVisible) Show();
        PlaceNear(caret);
        var handle = new WindowInteropHelper(this).Handle;
        if (handle != IntPtr.Zero)
        {
            NativeMethods.SetWindowPos(handle, NativeMethods.HWND_TOPMOST, 0, 0, 0, 0,
                NativeMethods.SWP_NOACTIVATE | NativeMethods.SWP_SHOWWINDOW
                    | 0x0001 /* SWP_NOSIZE */ | 0x0002 /* SWP_NOMOVE */);
        }
    }

    public void Dismiss()
    {
        if (IsVisible) Hide();
    }

    // MARK: - Monitor geometry, in physical pixels

    private static HostRect PointerAnchor()
    {
        if (!NativeMethods.GetCursorPos(out var cursor)) return new HostRect(0, 0, 1, 1);
        return new HostRect(cursor.X, cursor.Y, 1, 1);
    }

    private static IntPtr MonitorFor(HostRect anchor)
    {
        var point = new NativeMethods.POINT
        {
            X = (int)Math.Round(anchor.MidX),
            Y = (int)Math.Round(anchor.MidY),
        };
        return NativeMethods.MonitorFromPoint(point, NativeMethods.MONITOR_DEFAULTTONEAREST);
    }

    private static double MonitorScale(IntPtr monitor)
    {
        if (monitor != IntPtr.Zero
            && NativeMethods.GetDpiForMonitor(monitor, NativeMethods.MDT_EFFECTIVE_DPI,
                out var dpiX, out _) == 0
            && dpiX > 0)
        {
            return dpiX / 96.0;
        }
        return 1.0;
    }

    private static NativeMethods.RECT WorkArea(IntPtr monitor)
    {
        var info = new NativeMethods.MONITORINFO
        {
            cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf<NativeMethods.MONITORINFO>(),
        };
        if (monitor != IntPtr.Zero && NativeMethods.GetMonitorInfo(monitor, ref info))
        {
            return info.rcWork;
        }
        return new NativeMethods.RECT { Left = 0, Top = 0, Right = 1920, Bottom = 1080 };
    }
}
