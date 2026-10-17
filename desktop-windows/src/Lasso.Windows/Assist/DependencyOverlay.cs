//  The native highlight overlay.
//
//  Lasso owns this visual layer entirely: the host application's document is
//  never touched. A borderless, transparent, non-activating window floats above
//  the focused window and draws a thin underline beneath each linked phrase.
//  Mouse events pass straight through, so the user keeps typing and selecting
//  in the host exactly as before; a separate observer watches the pointer and
//  tells the overlay when it is over a dependency.
//
//  Geometry arrives in physical screen pixels, because that is what both UI
//  Automation and the window manager report. The drawing surface is scaled by
//  the monitor's own factor so everything inside can be expressed in those same
//  pixels, with no second coordinate system to get wrong.

using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using Lasso.Core;
using Lasso.Windows.Interop;

namespace Lasso.Windows.Assist;

// MARK: - Appearance

/// Styling is chosen by dependency state, never hardcoded at the call site.
public static class DependencyStyle
{
    /// Source identity colours avoid warning red and amber, which stay
    /// reserved for stale, changed, and missing dependencies.
    private static readonly Color[] SourceColors =
    [
        Color.FromRgb(0x1F, 0x7A, 0xF0),
        Color.FromRgb(0x7A, 0x52, 0xE1),
        Color.FromRgb(0x00, 0x8C, 0x94),
        Color.FromRgb(0xC7, 0x40, 0x94),
        Color.FromRgb(0x1F, 0x99, 0x52),
        Color.FromRgb(0x42, 0x5C, 0xD6),
        Color.FromRgb(0x00, 0x85, 0xBD),
        Color.FromRgb(0x99, 0x4D, 0xB8),
    ];

    public static int SourceColorCount => SourceColors.Length;

    public static Color Stroke(DependencyVisualState state, int sourceSlot) => state switch
    {
        DependencyVisualState.Healthy =>
            SourceColors[(sourceSlot % SourceColors.Length + SourceColors.Length) % SourceColors.Length],
        DependencyVisualState.Changed => Color.FromRgb(0xDE, 0xA8, 0x4A),
        DependencyVisualState.Stale => Color.FromRgb(0xD9, 0xB8, 0x59),
        DependencyVisualState.Missing => Color.FromRgb(0xD9, 0x66, 0x61),
        _ => Colors.Transparent,
    };

    public static bool IsDashed(DependencyVisualState state) =>
        state is DependencyVisualState.Stale or DependencyVisualState.Missing;
}

// MARK: - Drawing

internal sealed class OverlayView : FrameworkElement
{
    public IReadOnlyList<DependencyGeometry> Geometries { get; set; } = [];
    public Dictionary<string, DependencyVisualState> States { get; set; } = [];
    public Dictionary<string, int> SourceSlots { get; set; } = [];
    public string? HoveredId { get; set; }
    public bool Debug { get; set; }

    /// Screen-space frame of the window that owns this view, in physical px.
    public HostRect WindowFrame { get; set; }

    protected override void OnRender(DrawingContext context)
    {
        foreach (var geometry in Geometries)
        {
            var state = States.GetValueOrDefault(geometry.ReferenceId, DependencyVisualState.Healthy);
            if (!state.IsDrawn() && !Debug) continue;
            var hovered = geometry.ReferenceId == HoveredId;
            var slot = SourceSlots.GetValueOrDefault(geometry.ReferenceId, 0);
            var color = DependencyStyle.Stroke(state, slot);

            var strokeBrush = new SolidColorBrush(color) { Opacity = hovered ? 1.0 : 0.90 };
            strokeBrush.Freeze();
            var washBrush = new SolidColorBrush(color) { Opacity = hovered ? 0.16 : 0.08 };
            washBrush.Freeze();

            var pen = new Pen(strokeBrush, hovered ? 2.0 : 1.25);
            if (DependencyStyle.IsDashed(state)) pen.DashStyle = new DashStyle([3, 2], 0);
            pen.Freeze();

            foreach (var fragment in geometry.Fragments)
            {
                var local = HostGeometryConverter.ToOverlayLocal(fragment, WindowFrame);
                var box = new Rect(local.X, local.Y, local.Width, local.Height);

                // A faint wash, kept well below the text's own contrast.
                context.DrawRoundedRectangle(washBrush, null,
                    new Rect(box.X - 1, box.Y, box.Width + 2, box.Height), 4, 4);

                // The underline sits just under the baseline.
                var y = box.Bottom - 0.5;
                context.DrawLine(pen, new Point(box.X, y), new Point(box.Right, y));

                if (Debug)
                {
                    var debugPen = new Pen(Brushes.HotPink, 0.5);
                    debugPen.Freeze();
                    context.DrawRectangle(null, debugPen, box);
                }
            }
        }
    }
}

// MARK: - Window

/// A window that never takes focus and never swallows a click, so the host
/// application keeps behaving normally everywhere.
internal sealed class OverlayWindow : Window
{
    private readonly OverlayView _view = new();
    private readonly ScaleTransform _scale = new(1, 1);

    public OverlayView View => _view;

    public OverlayWindow()
    {
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        ShowActivated = false;
        Topmost = true;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        Title = "Lasso highlights";

        var host = new Grid { RenderTransform = _scale };
        host.Children.Add(_view);
        Content = host;

        SourceInitialized += (_, _) =>
        {
            var handle = new WindowInteropHelper(this).Handle;
            if (handle == IntPtr.Zero) return;
            var style = NativeMethods.GetWindowLong(handle, NativeMethods.GWL_EXSTYLE);
            // Transparent to the mouse: clicks reach the application beneath.
            NativeMethods.SetWindowLong(handle, NativeMethods.GWL_EXSTYLE,
                style | NativeMethods.WS_EX_LAYERED | NativeMethods.WS_EX_TRANSPARENT
                    | NativeMethods.WS_EX_NOACTIVATE | NativeMethods.WS_EX_TOOLWINDOW);
        };
    }

    /// Places the overlay over a region given in physical screen pixels.
    public void Cover(HostRect region, double monitorScale)
    {
        _scale.ScaleX = 1 / monitorScale;
        _scale.ScaleY = 1 / monitorScale;
        _view.WindowFrame = region;
        _view.Width = region.Width;
        _view.Height = region.Height;
        _view.InvalidateVisual();

        var handle = new WindowInteropHelper(this).Handle;
        if (handle == IntPtr.Zero)
        {
            Left = region.MinX / monitorScale;
            Top = region.MinY / monitorScale;
            Width = region.Width / monitorScale;
            Height = region.Height / monitorScale;
            return;
        }
        NativeMethods.SetWindowPos(handle, NativeMethods.HWND_TOPMOST,
            (int)Math.Round(region.MinX), (int)Math.Round(region.MinY),
            (int)Math.Round(region.Width), (int)Math.Round(region.Height),
            NativeMethods.SWP_NOACTIVATE);
    }
}
