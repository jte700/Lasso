using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using WpfWindow = System.Windows.Window;

namespace Lasso.Windows.Assist;

// Each small nonactivating window covers one verified phrase rectangle. There
// is no screen-sized input shield, and keyboard focus stays in the host editor.
internal sealed class ReferenceHighlights : IDisposable
{
    private readonly List<Highlight> windows = [];
    internal event Action<AcceptedReference>? OpenRequested;

    internal void Present(AutomationReader.ReferenceGeometry[] geometry)
    {
        var index = 0;
        foreach (var item in geometry)
        foreach (var rect in item.Bounds)
        {
            if (index == 160) break;
            if (windows.Count <= index)
            {
                var window = new Highlight();
                window.OpenRequested += reference => OpenRequested?.Invoke(reference);
                windows.Add(window);
            }
            windows[index++].Present(item.Reference, rect);
        }
        for (; index < windows.Count; index++) windows[index].Hide();
    }

    internal void Hide() { foreach (var window in windows) window.Hide(); }
    public void Dispose() { foreach (var window in windows) window.Close(); windows.Clear(); }

    private sealed class Highlight : WpfWindow
    {
        private readonly Border mark = new() { Background = new SolidColorBrush(Color.FromArgb(16, 0, 103, 192)),
            BorderBrush = SystemColors.HotTrackBrush, BorderThickness = new Thickness(0, 0, 0, 1.5) };
        private AcceptedReference? reference;
        private IntPtr hwnd;
        internal event Action<AcceptedReference>? OpenRequested;
        internal Highlight()
        {
            WindowStyle = WindowStyle.None; ResizeMode = ResizeMode.NoResize;
            AllowsTransparency = true; Background = Brushes.Transparent;
            ShowActivated = false; ShowInTaskbar = false; Topmost = true;
            Focusable = false; Cursor = Cursors.Hand; Content = mark;
            SourceInitialized += (_, _) =>
            {
                hwnd = new WindowInteropHelper(this).Handle;
                var style = AssistNative.GetWindowLongPtr(hwnd, -20).ToInt64();
                AssistNative.SetWindowLongPtr(hwnd, -20, new IntPtr(style | 0x08000000L | 0x80L));
                HwndSource.FromHwnd(hwnd)?.AddHook(Procedure);
            };
            MouseLeftButtonUp += (_, e) =>
            {
                if (reference != null && AssistNative.GetForegroundWindow().ToInt64() == reference.HostWindow)
                    OpenRequested?.Invoke(reference);
                e.Handled = true;
            };
        }
        private IntPtr Procedure(IntPtr window, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (message == 0x21) { handled = true; return new IntPtr(3); }
            return IntPtr.Zero;
        }
        internal void Present(AcceptedReference value, Rect rect)
        {
            reference = value;
            ToolTip = $"{value.Text} — {value.Path}\\nClick to open source";
            if (!IsVisible) Show();
            AssistNative.SetWindowPos(hwnd, new IntPtr(-1), (int)Math.Floor(rect.X), (int)Math.Floor(rect.Y),
                Math.Max(1, (int)Math.Ceiling(rect.Width)), Math.Max(1, (int)Math.Ceiling(rect.Height)), 0x0010);
        }
    }
}
