using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using WpfButton = System.Windows.Controls.Button;
using WpfWindow = System.Windows.Window;

namespace Lasso.Windows.Assist;

/// <summary>A native WPF surface that never takes the insertion target's keyboard focus.</summary>
internal sealed class AssistPopup : WpfWindow
{
    private readonly System.Windows.Controls.ListBox rows = new()
    {
        Focusable = false, IsTabStop = false, BorderThickness = new Thickness(1),
        BorderBrush = SystemColors.ControlDarkBrush, MaxHeight = 240,
        HorizontalContentAlignment = HorizontalAlignment.Stretch
    };
    private readonly TextBlock heading = new() { FontSize = 12, FontWeight = FontWeights.SemiBold };
    private readonly TextBlock previewTitle = new() { FontSize = 12, FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly TextBlock preview = new() { FontSize = 12, TextWrapping = TextWrapping.Wrap, MaxHeight = 112, Margin = new Thickness(0, 6, 0, 0) };
    private readonly WpfButton sourceButton;
    private readonly WpfButton shareButton;
    
    private IReadOnlyList<AssistSuggestion> suggestions = [];
    private IntPtr hwnd;

    internal event Action<int>? Selected;
    internal event Action? AcceptRequested;
    internal event Action<bool>? SourceRequested;
    internal event Action? DismissRequested;
    internal int SelectedIndex { get; private set; }

    internal AssistPopup()
    {
        Title = "Lasso suggestions";
        Width = 400;
        SizeToContent = SizeToContent.Height;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        ShowActivated = false;
        ShowInTaskbar = false;
        Topmost = true;
        Focusable = false;
        FontFamily = SystemFonts.MessageFontFamily;
        FontSize = SystemFonts.MessageFontSize;
        Foreground = SystemColors.WindowTextBrush;
        Background = SystemColors.ControlBrush;
        UseLayoutRounding = true;
        var content = new StackPanel();
        var header = new DockPanel { Margin = new Thickness(10, 7, 6, 5) };
        var dismiss = SmallButton("×", "Dismiss suggestions (Escape)");
        dismiss.Padding = new Thickness(7, 0, 7, 1);
        dismiss.Click += (_, _) => DismissRequested?.Invoke();
        DockPanel.SetDock(dismiss, Dock.Right);
        header.Children.Add(dismiss);
        header.Children.Add(new TextBlock { Text = "Lasso", FontWeight = FontWeights.SemiBold, FontSize = 14, VerticalAlignment = VerticalAlignment.Center });
        content.Children.Add(header);
        heading.Margin = new Thickness(10, 0, 10, 5);
        heading.Foreground = SystemColors.GrayTextBrush;
        content.Children.Add(heading);
        rows.Margin = new Thickness(8, 0, 8, 4);
        content.Children.Add(rows);
        var previewPanel = new StackPanel { Margin = new Thickness(10, 6, 10, 8) };
        previewPanel.Children.Add(previewTitle);
        preview.Foreground = SystemColors.GrayTextBrush;
        previewPanel.Children.Add(preview);
        content.Children.Add(new Border { BorderBrush = SystemColors.ControlLightBrush, BorderThickness = new Thickness(0, 1, 0, 0), Child = previewPanel });
        var actions = new DockPanel { LastChildFill = false, Margin = new Thickness(12, 0, 12, 10) };
        var accept = SmallButton("Accept", "Accept selected suggestion (Tab or Ctrl+Enter)");
        accept.Click += (_, _) => AcceptRequested?.Invoke();
        DockPanel.SetDock(accept, Dock.Right);
        actions.Children.Add(accept);
        sourceButton = SmallButton("Open source", "Open the indexed source (F4)");
        sourceButton.Click += (_, _) => SourceRequested?.Invoke(false);
        actions.Children.Add(sourceButton);
        shareButton = SmallButton("Share…", "Choose exactly what to share (Ctrl+Shift+Enter)");
        shareButton.Click += (_, _) => SourceRequested?.Invoke(true);
        actions.Children.Add(shareButton);
        content.Children.Add(actions);
        content.Children.Add(new TextBlock
        {
            Text = "↑ ↓ Select   Tab Link   Ctrl+Enter Text   Esc Close",
            FontSize = 10.5, Foreground = SystemColors.GrayTextBrush, Margin = new Thickness(14, 0, 12, 11)
        });
        Content = new Border { BorderBrush = SystemColors.ControlDarkBrush, BorderThickness = new Thickness(1), Child = content };
        SourceInitialized += (_, _) =>
        {
            hwnd = new WindowInteropHelper(this).Handle;
            var style = AssistNative.GetWindowLongPtr(hwnd, -20).ToInt64();
            AssistNative.SetWindowLongPtr(hwnd, -20, new IntPtr(style | 0x08000000L | 0x80L)); // NOACTIVATE | TOOLWINDOW
            HwndSource.FromHwnd(hwnd)?.AddHook(WindowProcedure);

        };
    }

    private static WpfButton SmallButton(string text, string help) => new()
    {
        Content = text, ToolTip = help, Focusable = false, IsTabStop = false,
        Padding = new Thickness(10, 4, 10, 4), Margin = new Thickness(0, 0, 5, 0), MinHeight = 28,
        FontSize = 12
    };

    private IntPtr WindowProcedure(IntPtr window, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (message == 0x21) { handled = true; return new IntPtr(3); } // WM_MOUSEACTIVATE → MA_NOACTIVATE
        return IntPtr.Zero;
    }

    internal void Present(AssistPrediction prediction, Rect caret)
    {
        suggestions = prediction.Suggestions;
        heading.Text = prediction.Heading;
        rows.Items.Clear();
        for (var i = 0; i < suggestions.Count; i++)
        {
            var index = i;
            var suggestion = suggestions[i];
            var text = new StackPanel { Margin = new Thickness(5, 4, 5, 4) };
            text.Children.Add(new TextBlock { Text = suggestion.Label, FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis, MaxWidth = 350 });
            var description = string.Join(" · ", new[] { FileName(suggestion.Path), suggestion.Location }.Where(s => !string.IsNullOrWhiteSpace(s)));
            text.Children.Add(new TextBlock { Text = description.Length > 0 ? description : suggestion.Detail, FontSize = 11, Opacity = 0.8, TextTrimming = TextTrimming.CharacterEllipsis, Margin = new Thickness(0, 3, 0, 0) });
            var item = new ListBoxItem { Content = text, Focusable = false, IsTabStop = false,
                HorizontalContentAlignment = HorizontalAlignment.Stretch, Padding = new Thickness(0) };
            item.PreviewMouseLeftButtonDown += (_, e) =>
            {
                Select(index); Selected?.Invoke(index);
                if (e.ClickCount == 2) AcceptRequested?.Invoke();
                e.Handled = true;
            };
            rows.Items.Add(item);
        }
        Select(0);
        UpdateLayout();
        if (!IsVisible) Show();
        Place(caret);
    }

    internal void Select(int index)
    {
        if (suggestions.Count == 0) return;
        SelectedIndex = Math.Clamp(index, 0, suggestions.Count - 1);
        rows.SelectedIndex = SelectedIndex;
        rows.ScrollIntoView(rows.Items[SelectedIndex]);
        var selected = suggestions[SelectedIndex];
        previewTitle.Text = selected.Path.Length > 0 ? selected.Path : "Sentence completion";
        preview.Text = selected.ObjectId == null ? selected.Detail : "Loading source context…";
        sourceButton.IsEnabled = selected.ObjectId != null;
        shareButton.IsEnabled = selected.ObjectId != null;
    }

    internal void SetPreview(string text) => preview.Text = text;

    internal void Place(Rect caret)
    {
        if (hwnd == IntPtr.Zero) return;
        var anchor = new AssistNative.NativeRect { Left = (int)caret.Left, Top = (int)caret.Top, Right = (int)caret.Right, Bottom = (int)caret.Bottom };
        var work = AssistNative.WorkArea(anchor);
        // Move onto the caret's monitor first so per-monitor DPI is correct for sizing.
        AssistNative.SetWindowPos(hwnd, new IntPtr(-1), anchor.Left, anchor.Bottom + 8, 0, 0, 0x0011);
        var dpi = Math.Max(96, AssistNative.GetDpiForWindow(hwnd)) / 96.0;
        var width = (int)Math.Ceiling(ActualWidth * dpi);
        var height = (int)Math.Ceiling(ActualHeight * dpi);
        var left = Math.Clamp(anchor.Left, work.Left + 8, Math.Max(work.Left + 8, work.Right - width - 8));
        var top = anchor.Bottom + 8;
        if (top + height > work.Bottom - 8) top = anchor.Top - height - 8;
        top = Math.Max(work.Top + 8, top);
        AssistNative.SetWindowPos(hwnd, new IntPtr(-1), left, top, 0, 0, 0x0011);
    }

    private static string FileName(string path) => path.Replace('\\', '/').Split('/').LastOrDefault() ?? path;
    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, uint attribute, ref int value, int size);
}
